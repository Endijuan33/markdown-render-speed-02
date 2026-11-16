import * as fs from 'node:fs';
import { parse as renderMarkdown } from './parse.js';

const inputRoot = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputRoot = process.env.MAKEFUN_OUTPUT_DIR || '/output';
const documents = JSON.parse(fs.readFileSync(`${inputRoot}/cases.json`, 'utf8'));
const rendered = documents.map(document => renderMarkdown(document.markdown));
fs.writeFileSync(`${outputRoot}/html.json`, JSON.stringify(rendered));
