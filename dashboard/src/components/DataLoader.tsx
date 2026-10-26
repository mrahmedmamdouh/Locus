import { useId, useRef, useState } from 'react';
import type { ExclusionOptions, FileReport } from '../lib/data';
import { Card } from './common';

const MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface LoadedFile {
  name: string;
  text: string | null;
  error?: string;
}

/** Read File objects as text, entirely in the browser. Oversized or unreadable files report an error. */
export async function readFiles(files: FileList | File[]): Promise<LoadedFile[]> {
  return Promise.all(
    [...files].map(async (f) => {
      if (f.size > MAX_FILE_BYTES) {
        return { name: f.name, text: null, error: `File is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.` };
      }
      try {
        return { name: f.name, text: await f.text() };
      } catch {
        return { name: f.name, text: null, error: 'Could not read file.' };
      }
    }),
  );
}

export function DataLoader({
  files,
  total,
  included,
  exclusion,
  onFiles,
  onSample,
  onClear,
  onExclusion,
}: {
  files: FileReport[];
  total: number;
  included: number;
  exclusion: ExclusionOptions;
  onFiles: (files: LoadedFile[]) => void;
  onSample: () => void;
  onClear: () => void;
  onExclusion: (e: ExclusionOptions) => void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handle(list: FileList | null) {
    if (!list || list.length === 0) return;
    setBusy(true);
    try {
      onFiles(await readFiles(list));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  const hasSynthetic = files.some((f) => f.synthetic);

  return (
    <Card
      title="Load data"
      subtitle="CSV exports from the Locus field-test app. Files are read locally and never uploaded."
    >
      <label
        htmlFor={inputId}
        className={`dropzone${over ? ' is-over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void handle(e.dataTransfer.files);
        }}
      >
        <strong>{busy ? 'Reading files…' : 'Drop CSV files here or choose files'}</strong>
        <span className="small muted">Multiple files are merged; duplicate reading ids are skipped.</span>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept=".csv,text/csv"
          multiple
          className="sr-only"
          onChange={(e) => void handle(e.target.files)}
        />
      </label>

      <div className="loader-actions">
        <button type="button" className="btn" onClick={onSample} disabled={hasSynthetic}>
          Load synthetic sample data
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClear} disabled={files.length === 0}>
          Clear all
        </button>
      </div>

      <fieldset className="exclusions">
        <legend>Exclude rows</legend>
        <label className="check">
          <input
            type="checkbox"
            checked={exclusion.excludeDemo}
            onChange={(e) => onExclusion({ ...exclusion, excludeDemo: e.target.checked })}
          />
          <span>
            Notes start with <code>DEMO</code> <span className="muted small">(app demo mode)</span>
          </span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={exclusion.excludeSynthetic}
            onChange={(e) => onExclusion({ ...exclusion, excludeSynthetic: e.target.checked })}
          />
          <span>
            Notes equal <code>synthetic</code> <span className="muted small">(generated sample data)</span>
          </span>
        </label>
      </fieldset>

      {files.length > 0 ? (
        <>
          <p className="small" style={{ marginTop: 14 }} aria-live="polite">
            <strong>{included.toLocaleString()}</strong> of {total.toLocaleString()} loaded readings included in
            the analysis.
          </p>
          <ul className="file-list" aria-label="Loaded files">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="file-item">
                <div>
                  <span className="file-name">{f.name}</span>{' '}
                  {f.synthetic ? <span className="tag tag-synthetic">Synthetic</span> : null}
                </div>
                <div className="small muted">
                  {f.added.toLocaleString()} added
                  {f.duplicates ? ` · ${f.duplicates.toLocaleString()} duplicate ids skipped` : ''}
                  {f.errors.length ? ` · ${f.errors.length.toLocaleString()} problem(s)` : ''}
                </div>
                {f.errors.length > 0 ? (
                  <details>
                    <summary>Show parse problems</summary>
                    <ul>
                      {f.errors.slice(0, 200).map((e, j) => (
                        <li key={j}>{e}</li>
                      ))}
                      {f.errors.length > 200 ? <li>…and {f.errors.length - 200} more</li> : null}
                    </ul>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}
