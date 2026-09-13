import { FinalProvenanceLedger } from './final-provenance-ledger.js';
import { runControlStateJourneys } from './control-state-journeys.js';
import { materializeInteractionSurface } from './interaction-materialization.js';

export interface InteractionBrowser {
  navigate(url: string): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  move(x: number, y: number): Promise<void>;
  click(x: number, y: number): Promise<void>;
  key(key: string, modifiers?: string[]): Promise<void>;
  type(text: string): Promise<void>;
  scroll(x: number, y: number, deltaY: number): Promise<void>;
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}
export interface InteractionSuiteOptions {
  referenceUrl: string;
  cloneUrl: string;
  outputDir: string;
  createBrowser(viewport: { width: number; height: number; mobile: boolean }): Promise<InteractionBrowser>;
  writeArtifact(path: string, content: string | Buffer): Promise<void>;
}
export type InteractionVerdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'UNVERIFIED';
export interface InteractionInventoryItem {
  id: string;
  selector: string;
  tag: string;
  name: string;
  href: string | null;
  events: string[];
  visible: boolean;
  disabled: boolean;
  inputType: string | null;
  parentSelector: string | null;
  states: string[];
  classes?: string[];
  attributes?: Record<string,string>;
}
export interface InteractionReceipt {
  id: string;
  viewport: string;
  verdict: InteractionVerdict;
  reason: string;
  evidence: string[];
  observations: unknown[];
}

/** Discovery is a denominator, never evidence that an interaction works. */
export function interactionInventoryScript(): string {
  return `(() => {
    const path = e => {
      const parts=[];
      while(e && e.nodeType===1) {
        const p=e.parentElement;
        const peers=p?Array.from(p.children).filter(n=>n.tagName===e.tagName):[e];
        parts.unshift(e.tagName.toLowerCase()+':nth-of-type('+(peers.indexOf(e)+1)+')');
        e=p;
      }
      return parts.join(' > ');
    };
    const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0;};
    const all=Array.from(document.querySelectorAll('*'));
    return all.filter(e=>e.matches('a,button,input,select,textarea,summary,[role="button"],[role="tab"],[tabindex]')||Array.from(e.attributes).some(a=>/^(?:@(?:click|mouse|focus|key)|x-on:|on(?:click|mouse|focus|key)|data-antifan-(?:toggle|hover|modal|slider))/.test(a.name))).map((e,i)=>{
      const events=Array.from(e.attributes).filter(a=>/^(?:@|x-on:|on(?:click|mouse|focus|key)|data-antifan-)/.test(a.name)).map(a=>a.name);
      const p=e.closest('[role="dialog"],dialog,.sub-menu,.popup,.category-navigation__block');
      const hiddenInput=e.matches('input[type="hidden"]');
      const disclosure=e.matches('summary,[aria-controls],[data-antifan-toggle],.menu-mobile,.open-login,.video-content__button,.info-more__button,.item-cta')||Array.from(e.attributes).some(a=>/^(?:@click|x-on:click)/.test(a.name)&&/=\\s*!/.test(a.value));
      const states=['initial'];
      if(!hiddenInput){if(!matchMedia('(pointer: coarse)').matches)states.push('hover');if(e.matches('a[href],button,input,select,textarea,summary,[tabindex]'))states.push('focus');states.push('activate');if(disclosure)states.push('exit','reopen');}
      return {id:'control-'+i,selector:path(e),tag:e.tagName.toLowerCase(),name:(e.getAttribute('aria-label')||e.getAttribute('title')||e.textContent||e.getAttribute('placeholder')||'').trim().replace(/\\s+/g,' ').slice(0,120),href:e.getAttribute('href'),events,visible:visible(e),disabled:e.matches(':disabled,[aria-disabled="true"],[inert]'),inputType:e.getAttribute('type'),parentSelector:p&&p!==e?path(p):null,classes:Array.from(e.classList),attributes:Object.fromEntries(Array.from(e.attributes).filter(a=>!/^wire:|value|password|token/i.test(a.name)).map(a=>[a.name,a.value])),states};
    });
  })()`;
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const literal = (value: unknown) => JSON.stringify(value);

async function observe(browser: InteractionBrowser, selector: string): Promise<{visible:boolean;hit:boolean;rect:{x:number;y:number;width:number;height:number}}> {
  const value = await browser.evaluate(`(() => {const e=document.querySelector(${literal(selector)});if(!e)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e);const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {visible:r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0,rect:{x:r.x,y:r.y,width:r.width,height:r.height},hit:!!hit&&(e===hit||e.contains(hit))};})()`);
  if (!value || typeof value !== 'object' || !('rect' in value) || !value.rect || typeof value.rect !== 'object') throw new Error('Missing browser target');
  const rect=value.rect;
  if (!('x' in rect) || typeof rect.x!=='number' || !('y' in rect) || typeof rect.y!=='number' || !('width' in rect) || typeof rect.width!=='number' || !('height' in rect) || typeof rect.height!=='number') throw new Error('Invalid browser geometry');
  return {visible:'visible' in value&&value.visible===true,hit:'hit' in value&&value.hit===true,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}};
}
async function point(browser: InteractionBrowser, selector: string): Promise<{x:number;y:number}> {
  await browser.evaluate(`document.querySelector(${literal(selector)})?.scrollIntoView({block:'center',inline:'nearest'})`);
  await pause(100);
  const state = await observe(browser, selector);
  if (!state.visible || !state.hit) throw new Error('Target is missing, hidden or occluded: '+selector);
  return { x:state.rect.x+state.rect.width/2,y:state.rect.y+state.rect.height/2 };
}
async function walk(browser: InteractionBrowser, from: {x:number;y:number}, to: {x:number;y:number}): Promise<void> {
  const steps=Math.max(2,Math.ceil(Math.hypot(to.x-from.x,to.y-from.y)/8));
  for(let i=1;i<=steps;i++) {await browser.move(from.x+(to.x-from.x)*i/steps,from.y+(to.y-from.y)*i/steps);await pause(16);}
}

export async function runInteractionSuite(options: InteractionSuiteOptions): Promise<{verdict:string;summary:Record<string,number>;receipts:InteractionReceipt[];provenance:FinalProvenanceLedger}> {
  const receipts: InteractionReceipt[]=[];
  const provenance=new FinalProvenanceLedger({instrumentRevision:'native-interaction-suite-v1'});
  const save=async(path:string,content:string|Buffer)=>{await options.writeArtifact(path,content);provenance.recordArtifact(path,content);};
  const viewports=[{name:'desktop',width:1440,height:900,mobile:false},{name:'tablet',width:1024,height:768,mobile:false},{name:'mobile',width:390,height:844,mobile:true}];
  for(const viewport of viewports) {
    let reference:InteractionBrowser|undefined,clone:InteractionBrowser|undefined;
    try {
      reference=await options.createBrowser(viewport);clone=await options.createBrowser(viewport);
      await reference.navigate(options.referenceUrl);await clone.navigate(options.cloneUrl);
      const referenceSettlement=await materializeInteractionSurface(reference);
      const cloneSettlement=await materializeInteractionSurface(clone);
      await save(`${viewport.name}/settlement.json`,JSON.stringify({reference:referenceSettlement,clone:cloneSettlement},null,2));
      const inventory=await reference.evaluate(interactionInventoryScript()) as InteractionInventoryItem[];
      await save(`${viewport.name}/feature-inventory.json`,JSON.stringify({schemaVersion:1,url:options.referenceUrl,viewport,items:inventory},null,2));
      const navigation=await reference.evaluate(`Array.from(document.querySelectorAll('.category-navigation__list > ul > li')).filter(e=>!e.closest('.sub-menu')).map((e,i)=>({index:i,name:e.textContent.trim()}))`) as Array<{index:number;name:string}>;
      if(!viewport.mobile) for(const item of navigation) {
        const receipt:InteractionReceipt={id:`navigation-${item.index}`,viewport:viewport.name,verdict:'FAIL',reason:'',evidence:[],observations:[]};
        try {
          for(const [surface,browser] of [['reference',reference],['clone',clone]] as const) {
            await browser.move(1,1);
            const parent=`.category-navigation__list > ul > li:nth-child(${item.index+1})`;
            const start=await point(browser,parent);
            await browser.move(start.x,start.y);await pause(200);
            const children=await browser.evaluate(`(() => {const panels=Array.from(document.querySelectorAll('#category-navigation__sub .sub-menu'));const p=panels[${item.index}];if(!p)return [];return Array.from(p.querySelectorAll('a')).map((e,i)=>({index:i,text:e.textContent.trim()}));})()`) as Array<{index:number;text:string}>;
            if(!children.length) throw new Error(surface+': no submenu links');
            const shot=`${viewport.name}/${receipt.id}-${surface}-open.png`;await save(shot,await browser.screenshot());receipt.evidence.push(shot);
            for(const child of children) {
              await browser.move(start.x,start.y);await pause(60);
              const selector=`#category-navigation__sub .sub-menu:nth-child(${item.index+1}) a`;
              const target=await browser.evaluate(`(() => {const e=document.querySelectorAll(${literal(selector)})[${child.index}];if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`) as {x:number;y:number}|null;
              if(!target) throw new Error(surface+': child missing');
              await walk(browser,start,target);
              const state=await browser.evaluate(`(() => {const panels=Array.from(document.querySelectorAll('#category-navigation__sub .sub-menu'));const visible=panels.filter(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'});const e=document.querySelectorAll(${literal(selector)})[${child.index}],hit=document.elementFromPoint(${target.x},${target.y});return {visiblePanels:visible.length,correctPanel:visible[0]===panels[${item.index}],childHit:!!e&&!!hit&&(e===hit||e.contains(hit))};})()`);
              receipt.observations.push({surface,child:child.index,state});
              if(!state||typeof state!=='object'||!('visiblePanels' in state)||state.visiblePanels!==1||!('correctPanel' in state)||state.correctPanel!==true||!('childHit' in state)||state.childHit!==true) throw new Error(surface+': dropdown child traversal failed at '+child.index);
            }
            const after=`${viewport.name}/${receipt.id}-${surface}-traversed.png`;await save(after,await browser.screenshot());receipt.evidence.push(after);
            await browser.move(1,1);await pause(250);
          }
          receipt.verdict='PASS';receipt.reason='All submenu child pointer trajectories remained visible and hit-testable on reference and clone; click navigation not included';
        } catch(error) {receipt.reason=String(error);}
        receipts.push(receipt);
      }
      receipts.push(...await runControlStateJourneys({reference,clone,inventory,viewport:viewport.name,mobile:viewport.mobile,referenceUrl:options.referenceUrl,cloneUrl:options.cloneUrl,save}));
    } catch(error) {receipts.push({id:'surface-load',viewport:viewport.name,verdict:'BLOCKED',reason:String(error),evidence:[],observations:[]});}
    finally {await reference?.close();await clone?.close();}
  }
  const summary:Record<string,number>={PASS:0,FAIL:0,BLOCKED:0,UNVERIFIED:0,total:receipts.length};
  for(const receipt of receipts) {
    summary[receipt.verdict]++;
    provenance.recordReceipt({
      id: receipt.id,
      verdict: receipt.verdict,
      surface: receipt.viewport,
      targetUrl: options.cloneUrl,
      evidence: receipt.evidence,
      reason: receipt.reason,
      timestamp: new Date().toISOString(),
    });
  }
  const verdict=summary.FAIL?'HARD_FAILED':summary.BLOCKED||summary.UNVERIFIED?'INCONCLUSIVE':'VERIFIED';
  await save('interaction-results.json',JSON.stringify({schemaVersion:1,verdict,summary,receipts},null,2));
  provenance.sealLedger('native-interaction-suite');
  await options.writeArtifact('provenance-ledger.json',JSON.stringify(provenance.toJSON(),null,2));
  return {verdict,summary,receipts,provenance};
}
