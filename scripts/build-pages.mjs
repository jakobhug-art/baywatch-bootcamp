import {copyFileSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';

const url=process.env.BOOTCAMP_SUPABASE_URL;
const key=process.env.BOOTCAMP_PUBLISHABLE_KEY;
if(!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url||'')||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key||'')){
 throw new Error('Configure BOOTCAMP_SUPABASE_URL and BOOTCAMP_PUBLISHABLE_KEY.');
}
const api=url+'/functions/v1/bootcamp';
const policy=[
 "default-src 'self'",
 "script-src 'self'",
 "style-src 'self' https://fonts.googleapis.com",
 "font-src https://fonts.gstatic.com",
 "img-src 'self' blob: "+url,
 "media-src 'self' blob: "+url,
 'connect-src '+url,
 "object-src 'none'",
 "base-uri 'none'",
 "form-action 'none'",
].join('; ');
const metadata=[
 '<meta name="bootcamp-api" content="'+api+'">',
 '<meta name="bootcamp-key" content="'+key+'">',
 '<meta http-equiv="Content-Security-Policy" content="'+policy+'">',
].join('\n ');
const source=readFileSync('index.html','utf8');
const version=source.match(/class="app-version">Version (\d+\.\d+\.\d+)</)?.[1];
if(!version) throw new Error('App version is missing.');
const html=source.replace('</head>',' '+metadata+'\n</head>')
 .replaceAll('./style.css','./style.css?v='+version)
 .replaceAll('./app.js','./app.js?v='+version);
mkdirSync('dist',{recursive:true});
for(const oldPortrait of ['bootcamp-portrait.jpg','bootcamp-portrait-2.jpg']){
 rmSync('dist/'+oldPortrait,{force:true});
}
writeFileSync('dist/index.html',html);
for(const asset of ['app.js','media-admin.mjs']){
 const script=readFileSync(asset,'utf8').replaceAll(/(\.\/(?:media-admin|season-media|voice-media)\.mjs)(?=['"])/g,'$1?v='+version);
 writeFileSync('dist/'+asset,script);
}
for(const asset of ['style.css','season-media.mjs','voice-media.mjs']) copyFileSync(asset,'dist/'+asset);
