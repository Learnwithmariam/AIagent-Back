import { extractText, getDocumentProxy } from 'unpdf';
import { unzipSync, strFromU8 } from 'fflate';

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

/** DOCX is a zip; the body text lives in word/document.xml. Paragraphs → lines, tabs kept. */
function extractDocx(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: (f) => f.name === 'word/document.xml' });
  const xml = files['word/document.xml'];
  if (!xml) throw Object.assign(new Error('Not a valid DOCX file.'), { status: 415 });
  return decodeXml(
    strFromU8(xml)
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Extract plain text from an uploaded course file (PDF, DOCX, TXT, MD). */
export async function extractTextFromFile(bytes: Uint8Array, filename: string, mimetype: string): Promise<string> {
  const name = filename.toLowerCase();

  if (mimetype === 'application/pdf' || name.endsWith('.pdf')) {
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    return pages
      .map((p, i) => `--- page ${i + 1} ---\n${String(p).trim()}`)
      .join('\n\n')
      .trim();
  }

  if (name.endsWith('.docx') || mimetype.includes('wordprocessingml')) {
    return extractDocx(bytes);
  }

  if (name.endsWith('.txt') || name.endsWith('.md') || mimetype.startsWith('text/')) {
    return new TextDecoder().decode(bytes).trim();
  }

  throw Object.assign(new Error('Unsupported file type. Use PDF, DOCX, TXT or MD. (PPTX: export to PDF first.)'), { status: 415 });
}
