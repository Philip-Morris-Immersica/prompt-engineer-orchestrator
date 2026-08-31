import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

// Types the browser can render directly in a tab; everything else is served
// as an attachment so the browser downloads it instead of showing a blank page.
const INLINE_EXTS = new Set(['.pdf', '.txt', '.md', '.csv', '.json', '.png', '.jpg', '.jpeg']);

// ── GET /api/runs/[runId]/files/[filename] — serves an uploaded reference
// file so it can be opened/downloaded directly from the run detail page.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ runId: string; filename: string }> }
) {
  try {
    const { runId, filename: rawFilename } = await params;
    const filename = decodeURIComponent(rawFilename);

    // Guard against path traversal — only allow a bare filename.
    if (path.basename(filename) !== filename || filename.includes('..')) {
      return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
    }

    const taskPath = path.join(DATA_DIR, 'runs', runId, 'task.json');
    const task = JSON.parse(await fs.readFile(taskPath, 'utf-8'));
    const uploadId: string | undefined = task.uploadId;
    if (!uploadId) {
      return NextResponse.json({ error: 'This run has no uploaded files' }, { status: 404 });
    }

    const filePath = path.join(DATA_DIR, 'uploads', uploadId, filename);

    // Confirm the resolved path is still inside the upload dir (extra safety
    // on top of the basename check above).
    const uploadDir = path.join(DATA_DIR, 'uploads', uploadId);
    if (!filePath.startsWith(uploadDir)) {
      return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
    }

    const data = await fs.readFile(filePath);
    const ext = path.extname(filename).toLowerCase();
    const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';
    const disposition = INLINE_EXTS.has(ext) ? 'inline' : 'attachment';

    return new NextResponse(data, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `${disposition}; filename="${encodeURIComponent(filename)}"`,
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
}
