import {
  ASSET_STATUSES,
  IMPORT_MAX_ROWS,
  assetNameSchema,
  assetNumberSchema,
  assetStatusLabels,
  errorResponseSchema,
  importQuerySchema,
  importResultSchema,
  type AssetStatus,
  type FieldValues,
  type ImportProblem,
} from '@open-itsm/shared';
import { parse } from 'csv-parse/sync';
import { eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { fromCsvCell, validateFieldValues, type FieldDef } from '../assets/fields.js';
import { takeAssetNumbers } from '../assets/numbers.js';
import { actorOf } from '../auth/http.js';
import type { Db } from '../db/client.js';
import { assets, assetTypes } from '../db/schema.js';
import { loadFields } from './asset-types.js';
import { ASSETS_WRITE, isUniqueViolation, type RouteDeps } from './deps.js';

type Row = {
  line: number;
  number: string | undefined;
  name: string;
  status: AssetStatus;
  fields: FieldValues;
};

type Column =
  | { kind: 'number' | 'name' | 'status'; header: string }
  | { kind: 'field'; header: string; field: FieldDef };

const statusByText = new Map<string, AssetStatus>(
  ASSET_STATUSES.flatMap((s) => [
    [s, s],
    [s.replace('_', ' '), s],
    [assetStatusLabels[s].toLowerCase(), s],
  ]),
);

function firstMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'is not valid';
}

/** Reads the file into rows, collecting every problem rather than stopping at the first. */
export function readImportFile(
  csv: string,
  fields: FieldDef[],
): { rows: Row[]; problems: ImportProblem[] } {
  const problems: ImportProblem[] = [];
  let records: { record: string[]; info: { lines: number } }[];
  try {
    records = parse(csv, {
      bom: true,
      info: true,
      relax_column_count: true,
      skip_empty_lines: true,
      record_delimiter: ['\r\n', '\n', '\r'],
    }) as unknown as typeof records;
  } catch (err) {
    const line = (err as { lines?: number }).lines ?? null;
    return {
      rows: [],
      problems: [
        {
          line,
          column: null,
          message: `The file is not valid CSV: ${(err as Error).message.split(':')[0]}. Save it from your spreadsheet as CSV and try again.`,
        },
      ],
    };
  }

  const [header, ...body] = records;
  if (!header) {
    return { rows: [], problems: [{ line: null, column: null, message: 'The file is empty.' }] };
  }

  const columns: (Column | undefined)[] = [];
  const seen = new Set<string>();
  for (const raw of header.record) {
    const text = raw.trim();
    const lower = text.toLowerCase();
    if (seen.has(lower)) {
      problems.push({ line: 1, column: text, message: 'This column appears more than once.' });
      columns.push(undefined);
      continue;
    }
    seen.add(lower);
    const field = fields.find((f) => f.label.toLowerCase() === lower || f.key === lower);
    if (lower === 'number' || lower === 'asset number')
      columns.push({ kind: 'number', header: text });
    else if (lower === 'name') columns.push({ kind: 'name', header: text });
    else if (lower === 'status') columns.push({ kind: 'status', header: text });
    else if (field) columns.push({ kind: 'field', header: text, field });
    else if (text === '') columns.push(undefined);
    else {
      problems.push({
        line: 1,
        column: text,
        message: 'This column is not Number, Name, Status or a field of this asset type.',
      });
      columns.push(undefined);
    }
  }
  if (!columns.some((c) => c?.kind === 'name')) {
    problems.push({ line: 1, column: 'Name', message: 'The file needs a Name column.' });
  }
  for (const field of fields) {
    if (field.required && !columns.some((c) => c?.kind === 'field' && c.field.key === field.key)) {
      problems.push({
        line: 1,
        column: field.label,
        message: 'This field is required for this asset type, so the file needs this column.',
      });
    }
  }
  if (body.length > IMPORT_MAX_ROWS) {
    problems.push({
      line: null,
      column: null,
      message: `The file has ${body.length} rows; import at most ${IMPORT_MAX_ROWS} at a time.`,
    });
  }
  if (problems.length > 0) return { rows: [], problems };

  const rows: Row[] = [];
  for (const { record, info } of body) {
    const line = info.lines;
    if (record.every((cell) => cell.trim() === '')) continue;
    if (record.length > header.record.length) {
      problems.push({
        line,
        column: null,
        message: `This row has ${record.length} cells but the header has ${header.record.length}.`,
      });
      continue;
    }
    const row: Row = { line, number: undefined, name: '', status: 'in_stock', fields: {} };
    for (const [i, column] of columns.entries()) {
      const cell = record[i] ?? '';
      if (!column) continue;
      if (column.kind === 'number' && cell.trim() !== '') {
        const parsed = assetNumberSchema.safeParse(cell);
        if (parsed.success) row.number = parsed.data;
        else problems.push({ line, column: column.header, message: firstMessage(parsed.error) });
      } else if (column.kind === 'name') {
        const parsed = assetNameSchema.safeParse(cell);
        if (parsed.success) row.name = parsed.data;
        else problems.push({ line, column: column.header, message: firstMessage(parsed.error) });
      } else if (column.kind === 'status' && cell.trim() !== '') {
        const status = statusByText.get(cell.trim().toLowerCase());
        if (status) row.status = status;
        else
          problems.push({
            line,
            column: column.header,
            message: `Use one of: ${ASSET_STATUSES.map((s) => assetStatusLabels[s]).join(', ')}.`,
          });
      } else if (column.kind === 'field') {
        const value = fromCsvCell(column.field, cell);
        if (value !== undefined) row.fields[column.field.key] = value;
      }
    }
    const checked = validateFieldValues(fields, row.fields);
    for (const p of checked.problems) {
      problems.push({
        line,
        column: p.label,
        message: `${p.message[0]?.toUpperCase()}${p.message.slice(1)}.`,
      });
    }
    row.fields = checked.values;
    rows.push(row);
  }
  if (rows.length === 0 && problems.length === 0) {
    problems.push({ line: null, column: null, message: 'The file has a header but no rows.' });
  }
  return { rows, problems };
}

/** Every number used twice in the file or already taken in the database, reported together. */
async function numberConflicts(db: Pick<Db, 'select'>, rows: Row[]): Promise<ImportProblem[]> {
  const problems: ImportProblem[] = [];
  const firstLine = new Map<string, number>();
  for (const row of rows) {
    if (!row.number) continue;
    const lower = row.number.toLowerCase();
    const earlier = firstLine.get(lower);
    if (earlier === undefined) firstLine.set(lower, row.line);
    else
      problems.push({
        line: row.line,
        column: 'Number',
        message: `${row.number} is also on line ${earlier}. Each asset needs its own number.`,
      });
  }
  const wanted = [...firstLine.keys()];
  for (let i = 0; i < wanted.length; i += 1000) {
    const taken = await db
      .select({ number: assets.number, typeName: assetTypes.name })
      .from(assets)
      .innerJoin(assetTypes, eq(assetTypes.id, assets.assetTypeId))
      .where(inArray(sql`lower(${assets.number})`, wanted.slice(i, i + 1000)));
    for (const t of taken) {
      problems.push({
        line: firstLine.get(t.number.toLowerCase()) ?? null,
        column: 'Number',
        message: `${t.number} is already used by an existing ${t.typeName} asset.`,
      });
    }
  }
  return problems;
}

export function registerAssetImportRoute(app: FastifyInstance, { db }: RouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/assets/import',
    {
      config: { access: ASSETS_WRITE },
      schema: {
        summary: 'Import assets of one type from CSV; nothing is created unless every row is valid',
        description: [
          'Send the file as the body with `Content-Type: text/csv`. The header names the columns:',
          '`Number` (optional; blank takes the next number), `Name`, `Status` (optional; default In stock)',
          'and one column per custom field, by label. Every problem, including every duplicate number',
          'within the file or against existing assets, is reported at once with its line. Use',
          '`dryRun=true` to check a file without importing it.',
        ].join(' '),
        tags: ['assets'],
        querystring: importQuerySchema,
        body: z.string(),
        response: { 200: importResultSchema, 404: errorResponseSchema, 422: importResultSchema },
      },
    },
    async (request, reply) => {
      const { typeId, dryRun } = request.query;
      const [type] = await db
        .select({ id: assetTypes.id })
        .from(assetTypes)
        .where(eq(assetTypes.id, typeId));
      if (!type) {
        return reply.code(404).send({
          error: 'type_not_found',
          message: 'That asset type no longer exists. Reload the page and choose another.',
        });
      }

      const { rows, problems } = readImportFile(request.body, await loadFields(db, typeId));
      problems.push(...(await numberConflicts(db, rows)));
      problems.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
      if (problems.length > 0) {
        return reply.code(422).send({ dryRun, rows: rows.length, created: 0, problems });
      }
      if (dryRun) return { dryRun, rows: rows.length, created: 0, problems };

      const { actorUserId, actorServiceAccountId } = actorOf(request);
      try {
        await db.transaction(async (tx) => {
          const reserved = new Set(rows.flatMap((r) => (r.number ? [r.number.toLowerCase()] : [])));
          const missing = rows.filter((r) => !r.number);
          const generated = (await takeAssetNumbers(tx, typeId, missing.length, reserved)) ?? [];
          missing.forEach((row, i) => (row.number = generated[i]));
          for (let i = 0; i < rows.length; i += 500) {
            await tx.insert(assets).values(
              rows.slice(i, i + 500).map((row) => ({
                number: row.number ?? '',
                assetTypeId: typeId,
                name: row.name,
                status: row.status,
                fields: row.fields,
                updatedByUserId: actorUserId,
                updatedByServiceAccountId: actorServiceAccountId,
              })),
            );
          }
        });
      } catch (err) {
        // Another change took one of the numbers between the check and the insert.
        if (isUniqueViolation(err, 'assets_number_key')) {
          return reply.code(422).send({
            dryRun,
            rows: rows.length,
            created: 0,
            problems: await numberConflicts(db, rows),
          });
        }
        throw err;
      }
      return { dryRun, rows: rows.length, created: rows.length, problems: [] };
    },
  );
}
