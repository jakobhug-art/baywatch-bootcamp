function decodeKey(value){
 return Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),character=>character.charCodeAt(0));
}

export function setupPush({api,registration}){
 const enable=document.querySelector('#push-enable');
 const disable=document.querySelector('#push-disable');
 const test=document.querySelector('#push-test');
 const status=document.querySelector('#push-status');
 const supported=Boolean(registration&&'Notification' in window&&'PushManager' in window);
 let account;

 function render(){
  const permission=supported?Notification.permission:null;
  const enabled=permission==='granted'&&account?.active;
  enable.hidden=!supported||permission==='denied'||Boolean(enabled);
  enable.disabled=!account?.key||Boolean(account?.busy);
  disable.hidden=!account?.active;
  test.hidden=!enabled;
  test.disabled=disable.disabled=Boolean(account?.busy);
  status.textContent=!supported?'Für Push brauchst du einen unterstützten Browser. Auf dem iPhone öffne Bootcamp vom Home-Bildschirm.':
   permission==='denied'?'Benachrichtigungen sind gesperrt. Erlaube sie in den Einstellungen deines Geräts oder Browsers.':
    account?.message||(account?.busy?'Gerätestatus wird geladen …':enabled?'Push ist auf diesem Gerät aktiv.':'Push ist auf diesem Gerät aus.');
 }

 function updateDevice(action,subscription){
  return api('push/device',{action,endpoint:subscription.endpoint,
   ...(action==='enable'?{keys:subscription.toJSON().keys}:{})});
 }

 async function removeDevice(subscription){
  await updateDevice('disable',subscription);
  await subscription.unsubscribe();
 }

 async function inspect(viewer){
  viewer.busy=true;
  viewer.message='';
  render();
  try{
   const [worker,{publicKey}]=await Promise.all([registration,api('push/key')]);
   if(account!==viewer) return;
   if(!worker?.pushManager) throw new Error('Push ist in diesem Browser gerade nicht verfügbar.');
   viewer.worker=worker;
   viewer.key=decodeKey(publicKey);
   viewer.subscription=await worker.pushManager.getSubscription();
   if(viewer.subscription) viewer.active=(await updateDevice('status',viewer.subscription)).active;
   viewer.ready=true;
  }catch(error){viewer.message=error.message;}
  finally{viewer.busy=false;if(account===viewer) render();}
 }

 enable.addEventListener('click',async()=>{
  const viewer=account;
  if(viewer?.busy||!viewer?.worker||!viewer.key) return;
  viewer.busy=true;
  viewer.message='';
  render();
  try{
   const subscription=viewer.subscription??await viewer.worker.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:viewer.key});
   if(account!==viewer){await subscription.unsubscribe();return;}
   viewer.subscription=subscription;
   viewer.active=(await updateDevice('enable',subscription)).active;
  }catch(error){viewer.message=error.name==='NotAllowedError'?'Die Push-Freigabe wurde nicht erteilt.':error.message;}
  finally{viewer.busy=false;if(account===viewer) render();}
 });
 disable.addEventListener('click',async()=>{
  const viewer=account;
  if(viewer?.busy||!viewer?.subscription) return;
  viewer.busy=true;
  viewer.message='';
  render();
  try{
   await removeDevice(viewer.subscription);
   viewer.active=false;
   viewer.subscription=null;
  }catch(error){viewer.message=error.message;}
  finally{viewer.busy=false;if(account===viewer) render();}
 });
 test.addEventListener('click',async()=>{
  const viewer=account;
  if(viewer?.busy||!viewer?.active||!viewer.subscription) return;
  viewer.busy=true;
  viewer.message='';
  render();
  try{
   await updateDevice('test',viewer.subscription);
   viewer.message='Testnachricht angefordert. Sie sollte innerhalb einer Minute ankommen.';
  }catch(error){viewer.message=error.message;}
  finally{viewer.busy=false;if(account===viewer) render();}
 });
 window.addEventListener('focus',()=>{if(account) render();});

 return {
  sync(user,visible){
   if(account?.id!==user?.id) account=user?{id:user.id}:undefined;
   if(!account||!visible) return;
   if(supported&&!account.ready&&!account.busy) inspect(account);
   else render();
  },
  async signOut(){
   account=undefined;
   if(!supported) return;
   const worker=await navigator.serviceWorker.getRegistration().catch(()=>null);
   const subscription=await worker?.pushManager?.getSubscription().catch(()=>null);
   if(!subscription) return;
   try{await removeDevice(subscription);}
   catch{await subscription.unsubscribe().catch(()=>{});}
  }
 };
}
