import { IMPORT_MAX_ROWS, type AssetType, type ImportResult } from '@open-itsm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createRoute } from '@tanstack/react-router';
import { useId, useState, type FormEvent } from 'react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, ErrorMessage } from '@/components/ui/card';
import { Input, Label, Select } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { Table, Td, Th } from '@/components/ui/table';
import { importAssets } from '@/lib/api';
import { assetTypesQuery } from '@/lib/queries';
import { authedRoute } from './authed';

export const assetImportRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/assets/import',
  component: ImportPage,
});

/** The header a spreadsheet needs for this type: the built-in columns, then each field. */
function exampleHeader(type: AssetType): string {
  return ['Number', 'Name', 'Status', ...type.fields.map((f) => f.label)]
    .map((h) => (/[",\n]/.test(h) ? `"${h.replaceAll('"', '""')}"` : h))
    .join(',');
}

function ImportPage() {
  const queryClient = useQueryClient();
  const typeId = useId();
  const fileId = useId();
  const types = useQuery(assetTypesQuery);
  const [chosenTypeId, setChosenTypeId] = useState<string>();
  const [file, setFile] = useState<{ name: string; text: string }>();
  const [check, setCheck] = useState<ImportResult>();
  const type = types.data?.find((t) => t.id === chosenTypeId) ?? types.data?.[0];

  const run = useMutation({
    mutationFn: ({ dryRun }: { dryRun: boolean }) => {
      if (!type || !file) throw new Error('Choose a type and a file first.');
      return importAssets(type.id, file.text, dryRun);
    },
    onSuccess: async (result) => {
      setCheck(result);
      if (!result.dryRun && result.created > 0) {
        await queryClient.invalidateQueries({ queryKey: ['assets'] });
        await queryClient.invalidateQueries({ queryKey: assetTypesQuery.queryKey });
      }
    },
  });

  /** Any change to the inputs makes the last check stale. */
  function reset() {
    setCheck(undefined);
    run.reset();
  }

  async function onFile(input: HTMLInputElement) {
    reset();
    const chosen = input.files?.[0];
    setFile(chosen ? { name: chosen.name, text: await chosen.text() } : undefined);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    run.mutate({ dryRun: true });
  }

  const imported = check && !check.dryRun && check.problems.length === 0;
  const ready = check?.dryRun && check.problems.length === 0;

  return (
    <>
      <nav aria-label="Breadcrumb" className="type-caption text-ink-muted">
        <Link to="/assets" activeOptions={{ exact: true }}>
          Assets
        </Link>{' '}
        <span aria-hidden="true">/</span> Import
      </nav>
      <PageHeader
        title="Import assets"
        caption={`Bring in up to ${IMPORT_MAX_ROWS.toLocaleString()} assets of one type from a CSV file. Nothing is saved unless every row is valid.`}
      />
      <ErrorMessage error={types.error} />
      {types.data && !type && (
        <p className="m-0">
          Add an asset type first; the file is checked against its fields.{' '}
          <Link to="/asset-types">Go to asset types</Link>
        </p>
      )}
      {type && (
        <Card>
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor={typeId}>Asset type</Label>
                <Select
                  id={typeId}
                  value={type.id}
                  onChange={(e) => {
                    reset();
                    setChosenTypeId(e.target.value);
                  }}
                >
                  {types.data?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={fileId}>CSV file</Label>
                <Input
                  id={fileId}
                  type="file"
                  accept=".csv,text/csv"
                  required
                  className="py-1"
                  onChange={(e) => void onFile(e.currentTarget)}
                />
              </div>
            </div>
            <div className="flex flex-col gap-2 type-caption text-ink-muted">
              <p className="m-0">
                The first row names the columns. Name is required; Number is optional (blank takes
                the next {type.prefix} number); Status is optional (blank means In stock).
                {type.fields.some((f) => f.required) &&
                  ` ${type.name} also needs ${type.fields
                    .filter((f) => f.required)
                    .map((f) => f.label)
                    .join(', ')}.`}{' '}
                Dates are YYYY-MM-DD; yes/no fields take yes or no.
              </p>
              <p className="m-0">
                Header for {type.name}:{' '}
                <code className="type-code text-ink">{exampleHeader(type)}</code>
              </p>
            </div>
            <ErrorMessage error={run.error} />
            <div className="flex flex-wrap gap-2">
              {ready ? (
                <>
                  <Button
                    variant="primary"
                    disabled={run.isPending}
                    onClick={() => run.mutate({ dryRun: false })}
                  >
                    Import {check.rows} {check.rows === 1 ? 'asset' : 'assets'}
                  </Button>
                  <Button type="submit" disabled={run.isPending}>
                    Check again
                  </Button>
                </>
              ) : (
                <Button type="submit" variant="primary" disabled={run.isPending || !file}>
                  Check file
                </Button>
              )}
            </div>
          </form>
        </Card>
      )}

      {ready && (
        <p role="status" className="m-0 flex items-center gap-2">
          <StatusBadge tone="success">Ready</StatusBadge>
          {file?.name} has {check.rows} valid {check.rows === 1 ? 'row' : 'rows'}. Import them when
          you are ready.
        </p>
      )}
      {imported && (
        <p role="status" className="m-0 flex flex-wrap items-center gap-2">
          <StatusBadge tone="success">Imported</StatusBadge>
          Added {check.created} {check.created === 1 ? 'asset' : 'assets'} from {file?.name}.{' '}
          <Link to="/assets" search={{ typeId: type?.id }}>
            View {type?.name} assets
          </Link>
        </p>
      )}
      {check && check.problems.length > 0 && (
        <section aria-labelledby="problems" className="flex flex-col gap-3">
          <h2 id="problems" className="m-0 type-heading">
            {check.problems.length} {check.problems.length === 1 ? 'problem' : 'problems'} to fix
          </h2>
          <p className="m-0 text-ink-muted">
            Nothing was imported. Fix these in your spreadsheet, save it as CSV again and check it.
          </p>
          <Table>
            <thead>
              <tr>
                <Th>Line</Th>
                <Th>Column</Th>
                <Th>Problem</Th>
              </tr>
            </thead>
            <tbody>
              {check.problems.map((p, i) => (
                <tr key={i}>
                  <Td className="type-id whitespace-nowrap">{p.line ?? '—'}</Td>
                  <Td className="whitespace-nowrap">{p.column ?? '—'}</Td>
                  <Td>{p.message}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      )}
    </>
  );
}
