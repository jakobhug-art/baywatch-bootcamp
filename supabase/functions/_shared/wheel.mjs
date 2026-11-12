export const wheel = [
 {title:'Jackpot am Strand', description:'Du gewinnst sofort 25 Punkte.', initial:25},
 {title:'Rettungsbonus', description:'Du gewinnst sofort 10 Punkte.', initial:10},
 {title:'Von der Welle erwischt', description:'Du verlierst sofort 25 Punkte.', initial:-25},
 {title:'Gegenwind', description:'Du verlierst sofort 10 Punkte.', initial:-10},
 {title:'Liegestütz-Rettung', description:'Mache bis Mitternacht 30 zusätzliche Liegestütze, um die 30 Minuspunkte zurückzuholen. Die Wandvariante zählt.', initial:-30, reward:0},
 {title:'Plank am Strand', description:'Halte heute eine zusätzliche Minute Plank für 10 Punkte.', initial:0, reward:10},
 {title:'Hoch zum Wachturm', description:'Mache heute 6 zusätzliche Klimmzüge für 15 Punkte.', initial:0, reward:15},
 {title:'Extrarunde', description:'Du gewinnst sofort 5 Punkte.', initial:5, bonus:true},
 {title:'Freier Tag', description:'Du gewinnst einen Gutschein für einen freien Tag. Löse ihn im Münzkonto ein, wenn du ihn brauchst.', initial:0, rest:true},
 {title:'Nibbler ❤️', description:'Hugo gibt Joni einen Nibbler.', initial:0},
 {title:'Münz-Jackpot', description:'Du gewinnst sofort 15 Münzen.', initial:0, coins:15}
];

export function drawWheelSlot(randomInt){
 return randomInt(100)===0 ? wheel.length-1 : randomInt(wheel.length-1);
}

export function drawScratchValues(randomInt){
 const roll=randomInt(100);
 const prize=roll<50?0:roll<74?1:roll<89?2:roll<99?3:15;
 if(prize) return [prize,prize,prize];
 const symbols=[1,2,3,15];
 const values=[symbols[randomInt(symbols.length)],symbols[randomInt(symbols.length)]];
 const last=values[0]===values[1]?symbols.filter(value=>value!==values[0]):symbols;
 return [...values,last[randomInt(last.length)]];
}
