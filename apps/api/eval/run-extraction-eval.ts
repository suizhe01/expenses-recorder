import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { compareExtraction, type ExpectedExtraction } from '../src/eval/extraction-eval.js';
import { createGeminiExtractor } from '../src/receipts/extraction.js';

const directory = join(import.meta.dirname, 'receipts');
const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.log('Skipping extraction eval: GEMINI_API_KEY is not set.');
} else {
  const names = (await readdir(directory)).filter((name) => extname(name) === '.json').sort();
  const extractor = createGeminiExtractor({ apiKey, model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash' });
  let passed = 0;

  for (const name of names) {
    const expected = JSON.parse(await readFile(join(directory, name), 'utf8')) as ExpectedExtraction;
    const stem = basename(name, '.json');
    const image = (await readdir(directory)).find((candidate) => basename(candidate, extname(candidate)) === stem && ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'].includes(extname(candidate).toLowerCase()));
    if (!image) throw new Error(`No image sibling for ${name}`);
    const contentType = mimeType(image);
    const result = await extractor.extract({ bytes: await readFile(join(directory, image)), contentType });
    const differences = result.status === 'succeeded'
      ? compareExtraction(expected, result.fields)
      : [{ path: 'extraction', expected: 'succeeded', actual: result }];

    if (differences.length === 0) {
      passed += 1;
      console.log(`PASS ${stem}`);
    } else {
      console.log(`FAIL ${stem}`);
      for (const difference of differences) console.log(`  ${difference.path}: expected ${JSON.stringify(difference.expected)}, actual ${JSON.stringify(difference.actual)}`);
    }
  }

  console.log(`Extraction eval: ${passed}/${names.length} cases passed.`);
  if (passed !== names.length) process.exitCode = 1;
}

function mimeType(name: string): string {
  const extension = extname(name).toLowerCase();
  return extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : ['.heic', '.heif'].includes(extension) ? 'image/heic' : 'image/jpeg';
}
