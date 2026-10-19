const fs = require('fs'), path = require('path');
// Run from the repository root: bun docs/review/audit.cjs
const root=process.cwd();
function walk(dir) { return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e => ['.git','.data','node_modules'].includes(e.name)?[]:e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]); }
const files=walk(root), broken=[], imports=[], caseMismatches=[];
const exactPaths = new Set(files.map(file => path.relative(root, file).replaceAll('\\', '/')));
function checkCase(file, target) {
 const relative = path.relative(root, target).replaceAll('\\', '/');
 if (fs.statSync(target).isFile() && !exactPaths.has(relative)) {
  caseMismatches.push({file:path.relative(root,file),target:relative});
 }
}
let links=0, localImports=0;
for (const file of files) {
 const text=fs.readFileSync(file,'utf8');
 if(file.endsWith('.md')) for(const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
  const raw=m[1].split(/\s+"/)[0].replace(/^<|>$/g,'');
  if(/^(https?:|mailto:|#)/.test(raw)) continue;
  links++;
  const target=decodeURIComponent(raw.split('#')[0]);
  const absolute = path.resolve(path.dirname(file),target);
  if(!fs.existsSync(absolute)) broken.push({file:path.relative(root,file),target:raw});
  else checkCase(file,absolute);
 }
 if(file.endsWith('.ts')) for(const m of text.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
  localImports++; const target=path.resolve(path.dirname(file),m[1]);
  const resolved = [target,target+'.ts',path.join(target,'index.ts')].find(p=>fs.existsSync(p));
  if(!resolved) imports.push({file:path.relative(root,file),target:m[1]});
  else checkCase(file,resolved);
 }
}
const result={files:files.length,localLinks:links,broken,localImports,unresolvedImports:imports,caseMismatches};
fs.writeFileSync('docs/review/link-import-audit.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
process.exitCode=broken.length||imports.length||caseMismatches.length?1:0;
