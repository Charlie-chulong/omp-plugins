import React from 'react';
import { ReminderPage } from './page.jsx';
import { status, configure, testReminder } from './rpc.mjs';

export default function setup(context) {
  const api = Object.freeze({
    read: () => context.rpc(status, {}),
    configure: enabled => context.rpc(configure, { enabled }),
    test: () => context.rpc(testReminder, {})
  });
  function Page({ theme }) { return <ReminderPage api={api} theme={theme} />; }
  context.addSettingsPage({ id: 'wechat-ask-notifier.settings', title: 'QQ 与微信询问提醒', icon: 'bell-ring', Component: Page });
  context.addCommandCenterItem({
    id: 'wechat-ask-notifier.open', title: '打开 QQ 与微信询问提醒', icon: 'bell-ring',
    keywords: ['QQ', '我的手机', '微信', '提醒', '问题', '文件传输助手'], context: 'global',
    onSelect: command => command.openSurface('wechat-ask-notifier.settings-surface')
  });
  context.addSurface('wechat-ask-notifier.settings-surface', Page);
}
