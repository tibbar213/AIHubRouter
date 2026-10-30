import {readFile,readdir,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const manifest=JSON.parse(await readFile('extension/manifest.json','utf8'));
for(const f of ['background.js','options.js','core.js'])execFileSync(process.execPath,['--check',`extension/${f}`],{stdio:'inherit'});
for(const f of [manifest.background.service_worker,manifest.options_page,...Object.values(manifest.icons)])await access('extension/'+f);
if(JSON.stringify(manifest.host_permissions)!==JSON.stringify(['https://aihub.top/*']))throw new Error('Unexpected host permissions');
for(const file of await readdir('extension'))if(/\.har$/.test(file))throw new Error('HAR must not be packaged');
console.log('Manifest, scripts, packaged assets and site scope verified.');
