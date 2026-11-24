export function setupProfile({api,refresh,saveSession,setStatus,isBusy,setBusy}){
 const nav=document.querySelector('#profile-nav');
 const settingsForm=document.querySelector('#profile-settings-form');
 const passwordForm=document.querySelector('#profile-password-form');
 let account;

 function setFields(settings){
  const fields=settingsForm.elements;
  fields.birthDate.value=settings.birthDate??'';
  fields.showBirthday.checked=settings.showBirthday;
  fields.morningReminder.checked=settings.morningReminder??settings.workoutReminders;
  fields.eveningReminder.checked=settings.eveningReminder??settings.workoutReminders;
  fields.friendNotifications.checked=settings.friendNotifications;
  fields.chatNotifications.checked=settings.chatNotifications??true;
  fields.foodNotifications.checked=settings.foodNotifications??true;
  const known=settings.birthdayMonthDay?.split('-').reverse().join('.');
  setStatus('#profile-known-birthday',known&&!settings.birthDate?'Dein Geburtstag am '+known+'. ist bereits hinterlegt.':'');
 }

 settingsForm.addEventListener('submit',async event=>{
  event.preventDefault();
  const viewer=account;
  if(isBusy()||!viewer?.ready) return;
  const fields=settingsForm.elements;
  const button=settingsForm.querySelector('[type="submit"]');
  setBusy(true);
  button.disabled=true;
  setStatus('#profile-status');
  try{
   await api('profile',{birthDate:fields.birthDate.value||null,showBirthday:fields.showBirthday.checked,
    morningReminder:fields.morningReminder.checked,eveningReminder:fields.eveningReminder.checked,
    friendNotifications:fields.friendNotifications.checked,chatNotifications:fields.chatNotifications.checked,
    foodNotifications:fields.foodNotifications.checked});
   if(account!==viewer) return;
   setStatus('#profile-status','Einstellungen gespeichert.');
   await refresh().catch(error=>setStatus('#notice',error.message));
  }catch(error){if(account===viewer) setStatus('#profile-status',error.message);}
  finally{button.disabled=false;setBusy(false);}
 });

 passwordForm.addEventListener('submit',async event=>{
  event.preventDefault();
  const viewer=account;
  if(isBusy()||!viewer) return;
  const {currentPassword,newPassword,confirmPassword}=passwordForm.elements;
  if(newPassword.value!==confirmPassword.value){
   setStatus('#profile-password-status','Die neuen Passwörter stimmen nicht überein.');
   confirmPassword.focus();
   return;
  }
  const button=passwordForm.querySelector('[type="submit"]');
  setBusy(true);
  button.disabled=true;
  setStatus('#profile-password-status');
  try{
   const result=await api('profile/password',{currentPassword:currentPassword.value,newPassword:newPassword.value});
   if(account!==viewer) return;
   passwordForm.reset();
   if(result.access_token) saveSession(result);
   setStatus('#profile-password-status',result.changed?'Passwort geändert. Verwende bei der nächsten Anmeldung dein neues Passwort.':'Passwort geändert.');
  }catch(error){if(account===viewer) setStatus('#profile-password-status',error.message);}
  finally{button.disabled=false;setBusy(false);}
 });

 return async (user,day,visible)=>{
  nav.hidden=!user;
  if(user?.id!==account?.id){
   account=user?{id:user.id,loading:false,ready:false}:undefined;
   settingsForm.hidden=true;
   settingsForm.reset();
   passwordForm.reset();
   setStatus('#profile-password-status');
   setStatus('#profile-status');
  }
  const viewer=account;
  if(!viewer||!visible) return;
  settingsForm.elements.birthDate.max=day;
  if(viewer.ready||viewer.loading) return;
  viewer.loading=true;
  setStatus('#profile-status','Profil wird geladen …');
  try{
   const settings=await api('profile');
   if(account!==viewer) return;
   setFields(settings);
   document.querySelector('#profile-handle').textContent=user.handle;
   viewer.ready=true;
   settingsForm.hidden=false;
   setStatus('#profile-status');
  }catch(error){if(account===viewer) setStatus('#profile-status',error.message);}
  finally{viewer.loading=false;}
 };
}
