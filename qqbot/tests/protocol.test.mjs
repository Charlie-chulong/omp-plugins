import { afterEach, expect, it } from 'vitest';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { startProtocolServer } from './protocol-server.mjs';
let fixture;
let bot;
afterEach(async()=>{bot?.stop();await fixture?.close();bot=undefined;fixture=undefined;});
it('real QQ SDK identifies, receives C2C and replies through actual protocol endpoints',async()=>{
  fixture=await startProtocolServer();
  bot=new QQBot({appId:fixture.appId,appSecret:fixture.clientSecret,baseUrl:fixture.base,tokenBaseUrl:fixture.base,reconnect:{maxAttempts:0}});
  const ready=new Promise(resolve=>bot.on('ready',resolve));
  let resolveMessage;
  const message=new Promise(resolve=>{resolveMessage=resolve;});
  bot.on('message',async context=>{await bot.sendMarkdown(context.replyTarget,`echo:${context.message.content}`);resolveMessage(context.message);});
  const running=bot.start();await ready;
  const result=await fetch(`${fixture.base}/__control/message`,{method:'POST',body:JSON.stringify({scope:'c2c',sender:'protocol-user',text:'hello'})});
  expect(result.ok).toBe(true);expect((await message).senderId).toBe('protocol-user');
  expect(fixture.connections).toBe(1);expect(fixture.outbound).toContainEqual(expect.objectContaining({path:'/v2/users/protocol-user/messages',body:expect.objectContaining({markdown:{content:'echo:hello'}})}));
  bot.stop();await running;
},10000);

it.each(['group','c2c'])('real SDK receives a type-11 %s button callback and acknowledges the raw event id',async scope=>{
  fixture=await startProtocolServer();
  bot=new QQBot({appId:fixture.appId,appSecret:fixture.clientSecret,baseUrl:fixture.base,tokenBaseUrl:fixture.base,reconnect:{maxAttempts:0}});
  const ready=new Promise(resolve=>bot.on('ready',resolve));
  let resolveInteraction;
  const interaction=new Promise(resolve=>{resolveInteraction=resolve;});
  bot.on('interaction',async(_context,event)=>{await bot.acknowledgeInteraction(event.id,0);resolveInteraction(event);});
  const running=bot.start();await ready;
  const eventId=`native-${scope}`;
  const response=await fetch(`${fixture.base}/__control/interaction`,{method:'POST',body:JSON.stringify({scope,peer:scope==='group'?'test-group':'test-user',sender:'test-user',eventId,data:'{"t":"game","g":9,"n":"fixture-nonce","a":"choose","i":0}'})});
  expect(response.ok).toBe(true);
  const event=await interaction;
  expect(event.type).toBe(11);expect(event.scene).toBe(scope);
  expect(scope==='group'?event.group_member_openid:event.user_openid).toBe('test-user');
  expect(fixture.outbound.some(reply=>reply.path===`/interactions/${eventId}`&&reply.body.code===0)).toBe(true);
  expect(fixture.outbound.some(reply=>reply.path.includes('INTERACTION_CREATE:'))).toBe(false);
  bot.stop();await running;
},10000);
