import fs from 'fs/promises';
import path from 'path';

export interface ParsedFile {
  filename: string;
  type: string;
  content: string;
  size: number;
}

export class FileParser {
  /**
   * Parse uploaded file based on extension
   */
  static async parseFile(filePath: string): Promise<ParsedFile> {
    const ext = path.extname(filePath).toLowerCase();
    const filename = path.basename(filePath);
    const stats = await fs.stat(filePath);

    let content = '';

    switch (ext) {
      case '.txt':
      case '.md':
        content = await this.parsePlainText(filePath);
        break;
      case '.pdf':
        // PDF support - requires runtime-only dependencies
        content = await this.parsePDFRuntime(filePath);
        break;
      case '.docx':
        // DOCX support - requires runtime-only dependencies
        content = await this.parseDOCXRuntime(filePath);
        break;
      default:
        throw new Error(`Unsupported file type: ${ext}`);
    }

    return {
      filename,
      type: ext.substring(1),
      content,
      size: stats.size,
    };
  }

  /**
   * Parse plain text files (.txt, .md)
   */
  private static async parsePlainText(filePath: string): Promise<string> {
    return await fs.readFile(filePath, 'utf-8');
  }

  /**
   * Parse PDF files (runtime only)
   */
  private static async parsePDFRuntime(filePath: string): Promise<string> {
    try {
      // @ts-ignore - Dynamic require for runtime only
      const pdfParse = require('pdf-parse');
      const dataBuffer = await fs.readFile(filePath);
      const data = await pdfParse(dataBuffer);
      return data.text;
    } catch (error) {
      console.warn('PDF parsing failed (library may not be available):', error);
      return `[PDF file: ${path.basename(filePath)} - content could not be extracted]`;
    }
  }

  /**
   * Parse DOCX files (runtime only)
   */
  private static async parseDOCXRuntime(filePath: string): Promise<string> {
    try {
      // @ts-ignore - Dynamic require for runtime only
      const mammoth = require('mammoth');
      const buffer = await fs.readFile(filePath);
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    } catch (error) {
      console.warn('DOCX parsing failed (library may not be available):', error);
      return `[DOCX file: ${path.basename(filePath)} - content could not be extracted]`;
    }
  }

  /**
   * Parse multiple files
   */
  static async parseFiles(filePaths: string[]): Promise<ParsedFile[]> {
    const results: ParsedFile[] = [];

    for (const filePath of filePaths) {
      try {
        const parsed = await this.parseFile(filePath);
        results.push(parsed);
      } catch (error) {
        console.error(`Failed to parse ${filePath}:`, error);
        // Continue with other files
      }
    }

    return results;
  }

  /**
   * Format parsed files for LLM context
   */
  static formatForContext(files: ParsedFile[]): string {
    if (files.length === 0) {
      return '';
    }

    const sections = files.map((file) => {
      return `### ${file.filename} (${file.type.toUpperCase()})

${file.content}

---`;
    });

    return `# Uploaded Reference Materials

${sections.join('\n\n')}`;
  }
}
