import {copyFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';

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
const html=readFileSync('index.html','utf8').replace('</head>',' '+metadata+'\n</head>');
mkdirSync('dist',{recursive:true});
writeFileSync('dist/index.html',html);
for(const asset of ['app.js','style.css']) copyFileSync(asset,'dist/'+asset);
