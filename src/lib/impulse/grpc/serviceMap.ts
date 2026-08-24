/*
 * Maps a TL method name to its gRPC service + method descriptor.
 *
 * Call sites use the same string the MTProto layer used — `invokeApi('messages.getDialogs')`
 * — so the lookup key is built straight from the proto descriptors at module
 * init. `localName` is protobuf-es's camelCase form, which already matches the
 * TL spelling after the dot; no case conversion is needed.
 */

import type {DescMethod, DescService} from '@bufbuild/protobuf';

import {Account} from './gen/account_pb';
import {Auth} from './gen/auth_pb';
import {Bots} from './gen/bots_pb';
import {Channels} from './gen/channels_pb';
import {Chatlists} from './gen/chatlists_pb';
import {Contacts} from './gen/contacts_pb';
import {Folders} from './gen/folders_pb';
import {Fragment} from './gen/fragment_pb';
import {Help} from './gen/help_pb';
import {Langpack} from './gen/langpack_pb';
import {Messages} from './gen/messages_pb';
import {Payments} from './gen/payments_pb';
import {Phone} from './gen/phone_pb';
import {Photos} from './gen/photos_pb';
import {Premium} from './gen/premium_pb';
import {Smsjobs} from './gen/smsjobs_pb';
import {Stats} from './gen/stats_pb';
import {Stickers} from './gen/stickers_pb';
import {Stories} from './gen/stories_pb';
import {Updates} from './gen/updates_pb';
import {Upload} from './gen/upload_pb';
import {Users} from './gen/users_pb';

const NAMESPACE_TO_SERVICE: Record<string, DescService> = {
  account: Account,
  auth: Auth,
  bots: Bots,
  channels: Channels,
  chatlists: Chatlists,
  contacts: Contacts,
  folders: Folders,
  fragment: Fragment,
  help: Help,
  langpack: Langpack,
  messages: Messages,
  payments: Payments,
  phone: Phone,
  photos: Photos,
  premium: Premium,
  smsjobs: Smsjobs,
  stats: Stats,
  stickers: Stickers,
  stories: Stories,
  updates: Updates,
  upload: Upload,
  users: Users
};

export type ServiceMethodInfo = {
  service: DescService,
  method: DescMethod
};

const METHOD_MAP = new Map<string, ServiceMethodInfo>();

for(const [namespace, service] of Object.entries(NAMESPACE_TO_SERVICE)) {
  for(const method of service.methods) {
    METHOD_MAP.set(`${namespace}.${method.localName}`, {service, method});
  }
}

export function getServiceAndMethod(methodName: string): ServiceMethodInfo | undefined {
  return METHOD_MAP.get(methodName);
}

/** Every TL method the gateway can serve — used by diagnostics and tests. */
export function getMappedMethodNames(): string[] {
  return Array.from(METHOD_MAP.keys());
}
