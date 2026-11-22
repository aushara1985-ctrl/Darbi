// Simulates the live failure: the DOM digit-observer rewrote Arabic-Indic digits in script text.
// After the fix the parser source contains no literal Arabic-Indic digits, so the rewrite is a no-op.
const fs=require('fs');const src=fs.readFileSync(require('path').join(__dirname,'../../public/v2.html'),'utf8');
function grab(s,name){const i=s.indexOf('function '+name+'(');let d=0,j=s.indexOf('{',i);for(let k=j;k<s.length;k++){if(s[k]=='{')d++;else if(s[k]=='}'){d--;if(d==0)return s.slice(i,k+1);}}}
let code=grab(src,'_arNormalize')+'\n'+grab(src,'extractCvFacts');
code=code.replace(/[٠-٩]/g,d=>String(d.charCodeAt(0)-0x0660)); // what the observer did live
const m={exports:{}};new Function('module',code+'\nmodule.exports=extractCvFacts;')(m);
const cv="TEST-Khalid\nSenior Sales Executive, TEST-SaaS Co, Dammam (2020-2026)\n- grew B2B revenue 27%\nSales Rep, TEST-Trading, Khobar (2017-2020)\nSkills: B2B sales";
const f=m.exports(cv); const ar=m.exports("TEST-سارة\nمسوقة بخبرة ١٠ سنوات في التسويق الرقمي والمحتوى B2B");
console.log(JSON.stringify({yrs:f.yearsExp,skills:f.skillsRaw,ar:ar.yearsExp}));
const ok=(f.yearsExp===null||(Number.isFinite(f.yearsExp)&&f.yearsExp>0))&&f.skillsRaw[0]==="B2B sales"&&!JSON.stringify(f).includes('-15')&&ar.yearsExp===10;
// observer guard present
const g=/p === 'SCRIPT' \|\| p === 'STYLE' \|\| p === 'TEXTAREA'/.test(src);
console.log(ok&&g?'PASS':'FAIL');process.exit(ok&&g?0:1);
