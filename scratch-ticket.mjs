function scratchCoating(canvas,onReveal){
 const context=canvas.getContext('2d',{willReadFrequently:true});
 if(!context) return;
 const {width,height}=canvas;
 const gradient=context.createLinearGradient(0,0,width,height);
 gradient.addColorStop(0,'#9b783b');
 gradient.addColorStop(.45,'#f6de9e');
 gradient.addColorStop(1,'#b48c49');
 context.fillStyle=gradient;
 context.fillRect(0,0,width,height);
 context.strokeStyle='#ffffff24';
 for(let x=-height;x<width;x+=12){
  context.beginPath();
  context.moveTo(x,0);
  context.lineTo(x+height,height);
  context.stroke();
 }
 context.fillStyle='#292015';
 context.font='bold 17px system-ui';
 context.textAlign='center';
 context.textBaseline='middle';
 context.fillText('✦  FREIRUBBELN  ✦',width/2,height/2);
 canvas.hidden=false;
 context.globalCompositeOperation='destination-out';
 context.strokeStyle='#000';
 context.lineWidth=34;
 context.lineCap='round';
 let pointer=null;
 let last;
 let frame;

 function erase(event){
  const bounds=canvas.getBoundingClientRect();
  const x=(event.clientX-bounds.left)*width/bounds.width;
  const y=(event.clientY-bounds.top)*height/bounds.height;
  context.beginPath();
  if(last){
   context.moveTo(...last);
   context.lineTo(x,y);
   context.stroke();
  }else{
   context.arc(x,y,context.lineWidth/2,0,2*Math.PI);
   context.fill();
  }
  last=[x,y];
  frame??=requestAnimationFrame(()=>{
   frame=undefined;
   if(canvas.hidden) return;
   const pixels=context.getImageData(0,0,width,height).data;
   const fieldWidth=width/3;
   for(let field=0;field<3;field++){
    let erased=0;
    for(let y=8;y<height;y+=16){
     for(let x=8;x<fieldWidth;x+=16){
      if(pixels[(y*width+field*fieldWidth+x)*4+3]<128) erased++;
     }
    }
    if(erased<.4*(fieldWidth/16)*(height/16)) return;
   }
   onReveal();
  });
 }

 canvas.addEventListener('pointerdown',event=>{
  if(pointer!==null || event.button!==0) return;
  pointer=event.pointerId;
  canvas.setPointerCapture(pointer);
  erase(event);
 });
 canvas.addEventListener('pointermove',event=>{
  if(event.pointerId===pointer) erase(event);
 });
 function stop(event){
  if(event.pointerId!==pointer) return;
  pointer=null;
  last=undefined;
 }
 canvas.addEventListener('pointerup',stop);
 canvas.addEventListener('pointercancel',stop);
 canvas.addEventListener('lostpointercapture',stop);
}

export function createScratchTicket(ticket,label,claim){
 const card=document.createElement('div');
 card.className='scratch-ticket';
 card.innerHTML=`<h3></h3><div class="scratch-fields">
  <div class="scratch-values" aria-hidden="true"><span></span><span></span><span></span></div>
  <canvas width="480" height="96" aria-hidden="true" hidden></canvas>
 </div><p class="scratch-status" role="status" hidden></p>
 <button type="button">Los direkt aufdecken</button>`;
 card.querySelector('h3').textContent=label;
 card.querySelectorAll('.scratch-values span').forEach((field,index)=>{
  field.textContent=ticket.values[index];
 });
 const values=card.querySelector('.scratch-values');
 const canvas=card.querySelector('canvas');
 const status=card.querySelector('.scratch-status');
 const button=card.querySelector('button');
 let revealed=false;

 function showResult(prize){
  canvas.hidden=true;
  button.hidden=true;
  status.hidden=false;
  status.textContent=ticket.values.join(' · ')+' — '+(prize===1?'1 Münze gewonnen!':prize?prize+' Münzen gewonnen!':'Niete');
  card.classList.toggle('scratch-won',prize>0);
 }

 async function reveal(){
  if(revealed) return;
  revealed=true;
  canvas.hidden=true;
  values.classList.remove('scratch-covered');
  button.disabled=true;
  status.hidden=false;
  status.textContent='Los wird ausgewertet …';
  try{
   const {prize}=await claim(ticket);
   showResult(prize);
  }catch(error){
   status.textContent=error.message;
   button.textContent='Erneut versuchen';
   button.disabled=false;
   revealed=false;
  }
 }

 if(ticket.claimed){
  showResult(ticket.values.every(value=>value===ticket.values[0])?ticket.values[0]:0);
 }else{
  values.classList.add('scratch-covered');
  scratchCoating(canvas,reveal);
  button.addEventListener('click',reveal);
 }
 return card;
}
