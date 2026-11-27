/** Reproducible, network-free OCR assets. Only copies the pinned npm packages. */
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'package.json'));
const dest=path.join(root,'public','ocr');
await mkdir(path.join(dest,'licenses'),{recursive:true});
const resolvePackage=name=>path.dirname(require.resolve(`${name}/package.json`));
const sources=[
 ['tesseract.js','dist/worker.min.js','worker.min.js'],
 ['tesseract.js-core','tesseract-core-lstm.js','tesseract-core-lstm.js'],
 ['tesseract.js-core','tesseract-core-lstm.wasm','tesseract-core-lstm.wasm'],
 ['@tesseract.js-data/jpn','4.0.0_best_int/jpn.traineddata.gz','jpn.traineddata.gz'],
 ['@tesseract.js-data/eng','4.0.0_best_int/eng.traineddata.gz','eng.traineddata.gz'],
 ['papaparse','LICENSE','licenses/papaparse-MIT.txt'],
 ['tesseract.js','LICENSE.md','licenses/tesseract-js-Apache-2.0.txt'],
 ['tesseract.js-core','LICENSE','licenses/tesseract-core-Apache-2.0.txt'],
 ['tesseract.js','dist/worker.min.js.LICENSE.txt','licenses/worker-dependencies.txt'],
];
const files=[];
for(const [pkg,from,to] of sources){
 const base=resolvePackage(pkg);const bytes=await readFile(path.join(base,from));
 await writeFile(path.join(dest,to),bytes);
 const meta=JSON.parse(await readFile(path.join(base,'package.json'),'utf8'));
 files.push({file:to,package:pkg,version:meta.version,license:meta.license,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
for(const language of ['jpn','eng']){
 const name=`@tesseract.js-data/${language}`;
 await writeFile(path.join(dest,'licenses',`${language}-package.json`),await readFile(path.join(resolvePackage(name),'package.json')));
}
const notice=`Study Desk local OCR assets\n\nTesseract.js 7.0.0 and tesseract.js-core 7.0.0: Apache-2.0.\nhttps://github.com/naptha/tesseract.js\nhttps://github.com/naptha/tesseract.js-core\n\n@tesseract.js-data/jpn and @tesseract.js-data/eng 1.0.0: npm package metadata declares MIT.\nThe distributed data uses 4.0.0_best_int (LSTM-only, integer data).\nhttps://github.com/naptha/tessdata\nUpstream Tesseract training data: https://github.com/tesseract-ocr/tessdata_best (Apache-2.0).\nPackage metadata and Apache/MIT texts are included.\n\nOnly the portable non-SIMD LSTM core and two required languages are shipped to reduce install size.\nNo CDN fallback is configured. Browser image data is processed in memory and not saved or sent.\nWorker filenames and hashes are recorded in assets.json. Rebuild with npm ci && npm run prepare:ocr.\n`;
await writeFile(path.join(dest,'licenses','NOTICE.txt'),notice);
await writeFile(path.join(dest,'licenses','MIT.txt'),`MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n`);
await writeFile(path.join(dest,'assets.json'),JSON.stringify({schemaVersion:1,files},null,2)+'\n');
console.log(`Prepared local OCR: ${files.reduce((n,f)=>n+f.bytes,0).toLocaleString()} bytes, Japanese + English, no network.`);
