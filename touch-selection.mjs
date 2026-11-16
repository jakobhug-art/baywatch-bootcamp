const holdTime=2500;
const moveTolerance=10;
const interactive='a,button,summary,label,input,textarea,select,[contenteditable],[role="button"],canvas';

export function setupTouchSelection(){
 if(!Intl.Segmenter) return;
 const touchScreen=matchMedia('(pointer: coarse)');
 const words=new Intl.Segmenter('de',{granularity:'word'});
 document.body.classList.add('touch-selection-enabled');
 let pending;
 let selected;

 function cancelHold(){
  clearTimeout(pending?.timer);
  pending=undefined;
 }

 function selectWord(target,x,y){
  target.classList.add('touch-selection');
  const caret=document.caretPositionFromPoint?.(x,y);
  const range=caret?null:document.caretRangeFromPoint?.(x,y);
  const node=caret?.offsetNode??range?.startContainer;
  const offset=caret?.offset??range?.startOffset;
  const word=node?.nodeType===Node.TEXT_NODE&&target.contains(node)
   ? words.segment(node.data).containing(offset) : null;
  if(!word?.isWordLike){target.classList.remove('touch-selection');return;}

  const selection=window.getSelection();
  selection.setBaseAndExtent(node,word.index,node,word.index+word.segment.length);
  selected=target;
 }

 document.addEventListener('pointerdown',event=>{
  cancelHold();
  if(!touchScreen.matches||event.pointerType!=='touch'||!event.isPrimary) return;
  const {target,clientX:x,clientY:y,pointerId}=event;
  if(!(target instanceof Element)||target.closest(interactive)||!target.textContent.trim()) return;
  if(selected){
   window.getSelection().removeAllRanges();
   selected.classList.remove('touch-selection');
   selected=undefined;
  }
  const timer=setTimeout(()=>{
   cancelHold();
   if(target.isConnected) selectWord(target,x,y);
  },holdTime);
  pending={timer,pointerId,x,y};
 },{passive:true});
 document.addEventListener('pointermove',event=>{
  if(pending?.pointerId===event.pointerId&&Math.hypot(event.clientX-pending.x,event.clientY-pending.y)>moveTolerance) cancelHold();
 },{passive:true});
 for(const type of ['pointerup','pointercancel','scroll']) document.addEventListener(type,cancelHold,{capture:true,passive:true});
 document.addEventListener('visibilitychange',cancelHold);
 document.addEventListener('selectionchange',()=>{
  if(selected&&window.getSelection().isCollapsed){
   selected.classList.remove('touch-selection');
   selected=undefined;
  }
 });
}
