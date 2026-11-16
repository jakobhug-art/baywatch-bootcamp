export function setupInstallableApp(hasPendingChanges){
 const query=new URLSearchParams(location.search);
 const installed=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true||query.get('app')==='1';
 const preview=query.get('install')==='1';
 if(!installed&&!preview) return;

 const manifest=document.createElement('link');
 manifest.rel='manifest';
 manifest.href='./app.webmanifest';
 document.head.append(manifest);

 const installPanel=document.querySelector('#app-install');
 const installGuide=document.querySelector('#app-install-guide');
 const installButton=document.querySelector('#app-install-button');
 if(preview&&!installed){
  installPanel.hidden=false;
  installGuide.textContent='Android: In Chrome das Menü öffnen und „App installieren“ wählen. iPhone: In Safari „Teilen“, „Zum Home-Bildschirm“ und „Als Web-App öffnen“ wählen.';
  let installPrompt;
  window.addEventListener('beforeinstallprompt',event=>{
   event.preventDefault();
   installPrompt=event;
   installButton.hidden=false;
  });
  installButton.addEventListener('click',async()=>{
   const prompt=installPrompt;
   if(!prompt) return;
   installPrompt=undefined;
   installButton.hidden=true;
   try{await prompt.prompt();}catch{/* The browser menu remains available. */}
  });
  window.addEventListener('appinstalled',()=>{installPanel.hidden=true;});
 }

 if(!('serviceWorker' in navigator)) return;
 const workers=navigator.serviceWorker;
 const update=document.querySelector('#app-update');
 const updateStatus=document.querySelector('#app-update-status');
 const updateButton=document.querySelector('#app-update-button');
 let applying=false;
 let reloadOnControl=false;
 let lastCheck=0;

 workers.addEventListener('controllerchange',()=>{
  if(reloadOnControl){location.reload();return;}
  if(applying) return;
  update.hidden=true;
 });

 workers.register('./sw.js',{updateViaCache:'none'}).then(registration=>{
  function showWaitingUpdate(){
   if(!registration.waiting||!workers.controller) return;
   update.hidden=false;
   updateStatus.textContent='Update verfügbar';
  }

  function watch(worker){
   worker?.addEventListener('statechange',()=>{if(worker.state==='installed') showWaitingUpdate();});
  }

  function checkForUpdate(){
   if(document.hidden||Date.now()-lastCheck<30000) return;
   lastCheck=Date.now();
   registration.update().then(showWaitingUpdate).catch(()=>{});
  }

  watch(registration.installing);
  registration.addEventListener('updatefound',()=>watch(registration.installing));
  document.addEventListener('visibilitychange',checkForUpdate);
  window.addEventListener('focus',checkForUpdate);
  setInterval(checkForUpdate,300000);
  showWaitingUpdate();

  updateButton.addEventListener('click',()=>{
   if(applying) return;
   if(hasPendingChanges()){
    updateStatus.textContent='Deine Änderungen werden noch gespeichert. Versuche es gleich noch einmal.';
    return;
   }
   const waiting=registration.waiting;
   if(!waiting){location.reload();return;}
   applying=true;
   reloadOnControl=true;
   updateButton.disabled=true;
   waiting.postMessage('bootcamp-activate');
   setTimeout(()=>{
    if(!applying) return;
    applying=false;
    reloadOnControl=false;
    updateButton.disabled=false;
    updateStatus.textContent='Das Update wartet noch. Versuche es erneut.';
   },10000);
  });
 }).catch(()=>{});
}
