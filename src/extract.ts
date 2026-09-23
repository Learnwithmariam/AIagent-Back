import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

/** Extract plain text from an uploaded course file (PDF, DOCX, TXT, MD). */
export async function extractTextFromFile(buffer: Buffer, filename: string, mimetype: string): Promise<string> {
  const name = filename.toLowerCase();

  if (mimetype === 'application/pdf' || name.endsWith('.pdf')) {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    return pages
      .map((p, i) => `--- page ${i + 1} ---\n${String(p).trim()}`)
      .join('\n\n')
      .trim();
  }

  if (name.endsWith('.docx') || mimetype.includes('wordprocessingml')) {
    const { value } = await mammoth.extractRawText({ buffer });
    return value.trim();
  }

  if (name.endsWith('.txt') || name.endsWith('.md') || mimetype.startsWith('text/')) {
    return buffer.toString('utf-8').trim();
  }

  throw Object.assign(new Error('Unsupported file type. Use PDF, DOCX, TXT or MD. (PPTX: export to PDF first.)'), { status: 415 });
}
