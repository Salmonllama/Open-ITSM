import { Camera, CameraOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { ErrorMessage } from './ui/card';

type Detector = { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> };
type DetectorClass = {
  new (options: { formats: string[] }): Detector;
  getSupportedFormats(): Promise<string[]>;
};

/** The browser's own QR reader where it has one (Chrome, Edge, Android); null elsewhere. */
async function nativeDetector(): Promise<Detector | null> {
  const BarcodeDetector = (window as unknown as { BarcodeDetector?: DetectorClass })
    .BarcodeDetector;
  if (!BarcodeDetector) return null;
  try {
    const formats = await BarcodeDetector.getSupportedFormats();
    return formats.includes('qr_code') ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
  } catch {
    return null;
  }
}

/** Reads QR codes with jsQR, loaded only when needed (Safari and Firefox). */
async function jsqrDetector(): Promise<Detector> {
  const { default: jsQR } = await import('jsqr');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  return {
    detect: (video) => {
      if (!context || video.videoWidth === 0) return Promise.resolve([]);
      // Scale large frames down: a tag fills much of the frame, and small frames decode faster.
      const scale = Math.min(1, 640 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(image.data, image.width, image.height, {
        inversionAttempts: 'dontInvert',
      });
      return Promise.resolve(code ? [{ rawValue: code.data }] : []);
    },
  };
}

function cameraProblem(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Camera access was refused. Allow the camera in your browser’s site settings, or use the field above.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'No camera was found. Use the field above with a USB scanner or by typing the number.';
  if (name === 'NotReadableError')
    return 'The camera is in use by another app. Close it and try again.';
  return 'The camera could not start. Try again, or use the field above.';
}

/**
 * Live camera preview that reports each QR code it reads. Pass `onCode` a stable callback; it is
 * called for every frame that holds a code, so the caller ignores repeats.
 */
export function QrCamera({ onCode }: { onCode: (text: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onCodeRef = useRef(onCode);
  const [on, setOn] = useState(false);
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    onCodeRef.current = onCode;
  }, [onCode]);

  useEffect(() => {
    if (!on) return;
    let stopped = false;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setProblem(
          'The camera works only when Open ITSM is opened at its https address. Use the field above instead.',
        );
        setOn(false);
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
      } catch (error) {
        setProblem(cameraProblem(error));
        setOn(false);
        return;
      }
      const video = videoRef.current;
      if (stopped || !video) return;
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      const detector = (await nativeDetector()) ?? (await jsqrDetector());

      const tick = async () => {
        if (stopped) return;
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          const codes = await detector.detect(video).catch(() => []);
          const text = codes[0]?.rawValue;
          if (text && !stopped) onCodeRef.current(text);
        }
        timer = setTimeout(() => void tick(), 150);
      };
      void tick();
    }

    void start();
    return () => {
      stopped = true;
      clearTimeout(timer);
      for (const track of stream?.getTracks() ?? []) track.stop();
    };
  }, [on]);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button
          onClick={() => {
            setProblem(undefined);
            setOn(!on);
          }}
        >
          {on ? (
            <>
              <CameraOff aria-hidden="true" strokeWidth={1.75} />
              Stop camera
            </>
          ) : (
            <>
              <Camera aria-hidden="true" strokeWidth={1.75} />
              Scan with camera
            </>
          )}
        </Button>
      </div>
      {on && (
        <video
          ref={videoRef}
          muted
          playsInline
          aria-label="Camera preview. Hold an asset tag’s QR code in view."
          className="aspect-[4/3] w-full max-w-md rounded-lg border border-line bg-black object-cover"
        />
      )}
      <ErrorMessage error={problem} />
    </div>
  );
}
