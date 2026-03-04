import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const DATA_DIR = process.env.DATA_DIR || './data';
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

// Ensure upload directory exists
async function ensureUploadDir() {
  try {
    await fs.access(UPLOAD_DIR);
  } catch {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
  }
}

export async function POST(request: NextRequest) {
  try {
    await ensureUploadDir();

    const formData = await request.formData();
    const files = formData.getAll('files') as File[];

    if (!files || files.length === 0) {
      return NextResponse.json(
        { error: 'No files uploaded' },
        { status: 400 }
      );
    }

    // Create unique upload session ID
    const uploadId = uuidv4();
    const uploadPath = path.join(UPLOAD_DIR, uploadId);
    await fs.mkdir(uploadPath, { recursive: true });

    const savedFiles: Array<{ filename: string; path: string; size: number }> =
      [];

    for (const file of files) {
      // Validate file type
      const ext = path.extname(file.name).toLowerCase();
      if (!['.txt', '.md', '.pdf', '.docx'].includes(ext)) {
        continue; // Skip unsupported files
      }

      // Save file
      const buffer = Buffer.from(await file.arrayBuffer());
      const filePath = path.join(uploadPath, file.name);
      await fs.writeFile(filePath, buffer);

      savedFiles.push({
        filename: file.name,
        path: filePath,
        size: buffer.length,
      });
    }

    return NextResponse.json({
      uploadId,
      files: savedFiles,
      count: savedFiles.length,
    });
  } catch (error) {
    console.error('Upload error:', error);
    return NextResponse.json(
      { error: 'Failed to upload files' },
      { status: 500 }
    );
  }
}
