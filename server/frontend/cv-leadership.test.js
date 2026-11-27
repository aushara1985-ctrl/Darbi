// 2026-11-25 live walk (career switcher, TEST-Faisal accountant -> data analyst): the diagnosis said
// "عندك خبرة في تحليل البيانات ... وفي إشارات قيادة". The CV had no leadership: "وعرضها على الإدارة"
// (reporting to management) matched the bare noun إدارة, and "تدريب" matched درب.
const fs=require('fs');const src=fs.readFileSync(require('path').join(__dirname,'../../public/v2.html'),'utf8');
function grab(s,name){const i=s.indexOf('function '+name+'(');let d=0,j=s.indexOf('{',i);for(let k=j;k<s.length;k++){if(s[k]=='{')d++;else if(s[k]=='}'){d--;if(d==0)return s.slice(i,k+1);}}}
const code=grab(src,'_arNormalize')+'\n'+grab(src,'extractCvFacts');
const m={exports:{}};new Function('module',code+'\nmodule.exports=extractCvFacts;')(m);
const f=m.exports;
const cases=[
  ["TEST-Faisal\nمحاسب عام (2019 - 2025)\n- تحليل الانحرافات في الميزانية وعرضها على الإدارة\n- حضرت تدريب Power BI", false],
  ["TEST-Noura\nمشرفة مبيعات، أدرت فريق من 6 موظفين (2018 - 2024)", true],
  ["TEST-Omar\nمدير قسم المشتريات - إدارة فريق المشتريات", true],
  ["TEST-Sam\nSales Manager, led a team of 5 (2019-2025)", true],
  ["TEST-Huda\nدربت 12 موظف جديد على النظام", true],
];
let ok=true;
for(const [cv,want] of cases){const got=!!f(cv).leadershipEvidence;console.log(want===got?'ok  ':'BAD ',want,got,cv.split('\n')[1]);if(want!==got)ok=false;}
// the experience sentence must not claim experience in the dream family
const sentenceOk=!/'عندك خبرة في ' \+ cFamAr/.test(src)&&/'، وهدفك مسار ' \+ cFamAr/.test(src);
console.log('sentence',sentenceOk);
console.log(ok&&sentenceOk?'PASS':'FAIL');process.exit(ok&&sentenceOk?0:1);
