import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from './parse.js';

const cases = JSON.parse(readFileSync('/input/cases.json', 'utf8'));
const out = [];
for (let i = 0; i < cases.length; i++) out.push(parse(cases[i].markdown));
mkdirSync('/output', { recursive: true });
writeFileSync('/output/html.json', JSON.stringify(out));
