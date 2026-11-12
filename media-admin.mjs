export function createMediaAdmin({root,api,timedFetch,setOptions,setError,monthFormat,onCurrentMediaDeleted}){
 const $=selector=>root.querySelector(selector);
 const mediaForm=$('#media-admin-form');
 const mediaSelect=mediaForm.elements.season;
 const mediaDownload=$('#media-download');
 const mediaDeleteButtons=[...root.querySelectorAll('[data-delete-media]')];
 let mediaOwner;
 let currentSeason;
 let mediaRequest=0;
 let mediaBusy=false;
 let mediaDownloaded=false;
 let mediaZipUrl;
 let mediaZipSeason;
 let mediaBackupId;
 const backedUpMedia=new Set();

 function updateMediaDeleteButtons(){
  for(const button of mediaDeleteButtons){
   const kind=button.dataset.deleteMedia;
   button.disabled=mediaBusy||!mediaDownloaded||!(kind==='all'?backedUpMedia.size:backedUpMedia.has(kind));
  }
 }

 function clearMediaDownload(){
  if(mediaZipUrl) URL.revokeObjectURL(mediaZipUrl);
  mediaZipUrl=undefined;
  mediaZipSeason=undefined;
  mediaBackupId=undefined;
  backedUpMedia.clear();
  mediaDownload.removeAttribute('href');
  mediaDownload.hidden=true;
  mediaDownloaded=false;
  updateMediaDeleteButtons();
 }

 function sync(adminId,seasonStart){
  currentSeason=seasonStart;
  root.hidden=!adminId;
  if(adminId===mediaOwner) return;
  mediaOwner=adminId;
  mediaRequest++;
  clearMediaDownload();
  mediaSelect.replaceChildren();
  setError('#media-status');
  if(adminId&&root.open) loadMediaSeasons().catch(error=>setError('#media-status',error.message));
 }

 function mediaSize(bytes){
  return new Intl.NumberFormat('de-DE',{maximumFractionDigits:1}).format(bytes/1000000)+' MB';
 }

 async function loadMediaSeasons(){
  const request=++mediaRequest;
  const seasons=await api('admin/media');
  if(request!==mediaRequest) return;
  const current=currentSeason;
  const total=seasons.reduce((sum,season)=>sum+Number(season.bytes),0);
  $('#media-usage').textContent='Fotos und Aufnahmen aller Seasons: '+mediaSize(total)+'.';
  setOptions(mediaSelect,seasons.map(season=>{
   const start=new Date(season.start+'T00:00:00Z');
   const next=new Date(start);
   next.setUTCMonth(next.getUTCMonth()+1);
   return [season.start,monthFormat.format(start)+' – '+monthFormat.format(next)+
    (season.start===current?' (laufend)':'')+' · '+season.files+' Dateien · '+mediaSize(season.bytes)];
  }));
  $('#media-export').disabled=!seasons.length;
  if(!seasons.length) setError('#media-status','Es gibt noch keine Fotos oder Aufnahmen.');
 }

 root.addEventListener('toggle',()=>{
  if(root.open&&mediaOwner&&!mediaBusy){
   loadMediaSeasons().catch(error=>setError('#media-status',error.message));
  }
 });
 mediaSelect.addEventListener('change',()=>{
  clearMediaDownload();
  setError('#media-status');
 });
 mediaForm.addEventListener('submit',async event=>{
  event.preventDefault();
  if(!mediaOwner || mediaBusy || !mediaSelect.value) return;
  const season=mediaSelect.value;
  const owner=mediaOwner;
  mediaBusy=true;
  mediaSelect.disabled=true;
  $('#media-export').disabled=true;
  clearMediaDownload();
  setError('#media-status','ZIP wird vorbereitet …');
  try{
   const {backupId,files}=await api('admin/media/'+season);
   if(!files.length) throw new Error('Für diese Season sind keine Dateien vorhanden.');
   const {seasonZip}=await import('./season-media.mjs');
   for(let i=0;i<files.length;i+=4){
    await Promise.all(files.slice(i,i+4).map(async file=>{
     const response=await timedFetch(file.url);
     if(!response.ok) throw new Error('Eine Datei konnte nicht geladen werden. Das ZIP wurde nicht erstellt.');
     file.bytes=new Uint8Array(await response.arrayBuffer());
    }));
    if(owner!==mediaOwner) return;
    setError('#media-status',Math.min(i+4,files.length)+' / '+files.length+' Dateien geladen.');
   }
   mediaZipUrl=URL.createObjectURL(seasonZip(files));
   mediaZipSeason=season;
   mediaBackupId=backupId;
   for(const {filename} of files) backedUpMedia.add(filename.startsWith('Fotos/')?'photos':'voice');
   mediaDownload.href=mediaZipUrl;
   mediaDownload.download='Baywatch-Bootcamp-'+season+'-Medien.zip';
   mediaDownload.hidden=false;
   setError('#media-status','Das ZIP ist bereit. Prüfe die heruntergeladene Datei vor dem Löschen.');
  }catch(error){
   if(owner===mediaOwner) setError('#media-status',error.message);
  }finally{
   mediaBusy=false;
   mediaSelect.disabled=false;
   $('#media-export').disabled=!mediaSelect.value;
   updateMediaDeleteButtons();
  }
 });
 mediaDownload.addEventListener('click',()=>{
  mediaDownloaded=true;
  updateMediaDeleteButtons();
 });
 async function deleteBackedUpMedia(kind){
  const season=mediaSelect.value;
  if(!mediaOwner || mediaBusy || !mediaDownloaded || season!==mediaZipSeason) return;
  const label={photos:'Fotos',voice:'Sprachnachrichten',all:'Fotos und Sprachnachrichten'}[kind];
  if(!window.confirm('Hast du das ZIP gespeichert und geprüft? '+label+' aus dieser Sicherung endgültig löschen?')) return;
  mediaBusy=true;
  mediaSelect.disabled=true;
  updateMediaDeleteButtons();
  $('#media-export').disabled=true;
  setError('#media-status','Dateien werden gelöscht …');
  try{
   let result;
   do{
    result=await api('admin/media/delete',{backupId:mediaBackupId,kind,confirm:true});
   }while(result.more);
   if(kind==='all') backedUpMedia.clear();
   else backedUpMedia.delete(kind);
   await loadMediaSeasons();
   if(season!==mediaSelect.value) clearMediaDownload();
   if(season===currentSeason) await onCurrentMediaDeleted(kind);
   setError('#media-status',label+' aus der Sicherung wurden gelöscht.');
  }catch(error){
   setError('#media-status',error.message);
  }finally{
   mediaBusy=false;
   mediaSelect.disabled=false;
   updateMediaDeleteButtons();
   $('#media-export').disabled=!mediaSelect.value;
  }
 }
 for(const button of mediaDeleteButtons){
  button.addEventListener('click',()=>deleteBackedUpMedia(button.dataset.deleteMedia));
 }

 return {sync};
}
