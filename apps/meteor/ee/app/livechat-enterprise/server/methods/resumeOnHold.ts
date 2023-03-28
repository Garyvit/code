import { Meteor } from 'meteor/meteor';
import { TAPi18n } from 'meteor/rocketchat:tap-i18n';
import type { ILivechatVisitor, IMessage } from '@rocket.chat/core-typings';
import { isOmnichannelRoom } from '@rocket.chat/core-typings';
import { Messages, LivechatVisitors, LivechatInquiry, LivechatRooms, Users } from '@rocket.chat/models';
import type { ServerMethods } from '@rocket.chat/ui-contexts';

import { RoutingManager } from '../../../../../app/livechat/server/lib/RoutingManager';
import { callbacks } from '../../../../../lib/callbacks';
import { methodDeprecationLogger } from '../../../../../app/lib/server/lib/deprecationWarningLogger';

async function resolveOnHoldCommentInfo(options: { clientAction: boolean }, room: any, onHoldChatResumedBy: any): Promise<string> {
	if (options.clientAction) {
		return TAPi18n.__('Omnichannel_on_hold_chat_resumed_manually', {
			user: onHoldChatResumedBy.name || onHoldChatResumedBy.username,
		});
	}
	const {
		v: { _id: visitorId },
	} = room;
	const visitor = await LivechatVisitors.findOneById<Pick<ILivechatVisitor, 'name' | 'username'>>(visitorId, {
		projection: { name: 1, username: 1 },
	});
	if (!visitor) {
		throw new Meteor.Error('error-invalid_visitor', 'Visitor Not found');
	}

	const guest = visitor.name || visitor.username;

	return TAPi18n.__('Omnichannel_on_hold_chat_automatically', { guest });
}

declare module '@rocket.chat/ui-contexts' {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface ServerMethods {
		'livechat:resumeOnHold'(roomId: string, options?: { clientAction: boolean }): void;
	}
}

Meteor.methods<ServerMethods>({
	async 'livechat:resumeOnHold'(roomId, options = { clientAction: false }) {
		methodDeprecationLogger.warn(
			'Method "livechat:resumeOnHold" is deprecated and will be removed in next major version. Please use "livechat/room.resumeOnHold" API instead.',
		);

		const room = await LivechatRooms.findOneById(roomId);
		if (!room || !isOmnichannelRoom(room)) {
			throw new Meteor.Error('error-invalid-room', 'Invalid room', {
				method: 'livechat:resumeOnHold',
			});
		}

		if (!room.onHold) {
			throw new Meteor.Error('room-closed', 'Room is not OnHold', {
				method: 'livechat:resumeOnHold',
			});
		}

		const inquiry = await LivechatInquiry.findOneByRoomId(roomId, {});
		if (!inquiry) {
			throw new Meteor.Error('inquiry-not-found', 'Error! No inquiry found for this room', {
				method: 'livechat:resumeOnHold',
			});
		}

		if (!room.servedBy) {
			throw new Meteor.Error('error-unserved-rooms-cannot-be-placed-onhold', 'Error! Un-served rooms cannot be placed OnHold', {
				method: 'livechat:resumeOnHold',
			});
		}

		const {
			servedBy: { _id: agentId, username },
		} = room;
		await RoutingManager.takeInquiry(inquiry, { agentId, username }, options);

		const onHoldChatResumedBy = options.clientAction ? await Meteor.userAsync() : await Users.findOneById('rocket.cat');
		if (!onHoldChatResumedBy) {
			throw new Meteor.Error('error-invalid-user', 'Invalid user', {
				method: 'livechat:resumeOnHold',
			});
		}

		const comment = await resolveOnHoldCommentInfo(options, room, onHoldChatResumedBy);

		const systemMsgUser: IMessage['u'] = {
			_id: onHoldChatResumedBy._id,
			username: onHoldChatResumedBy.username || '',
		};
		await Messages.createOnHoldHistoryWithRoomIdMessageAndUser(roomId, systemMsgUser, comment, 'resume-onHold');

		Meteor.defer(() => callbacks.run('livechat:afterOnHoldChatResumed', room));
	},
});
