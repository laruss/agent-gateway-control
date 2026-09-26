import { MattermostIdSchema } from "@agent-gateway/contracts";
import { z } from "zod";

/**
 * Response shapes of the Mattermost REST API v4 and WebSocket, as far as the Gateway reads them.
 * Loose objects: the server adds fields between versions, and unknown fields are ignored rather
 * than breaking ingest. Everything the Gateway relies on is validated.
 */

/** Post props; values are arbitrary JSON and set by whoever created the post. */
const PropsSchema = z
	.record(z.string(), z.json())
	.nullish()
	.transform((props) => props ?? {});

export const ApiPostSchema = z.looseObject({
	id: MattermostIdSchema,
	create_at: z.number().int(),
	update_at: z.number().int(),
	edit_at: z.number().int(),
	delete_at: z.number().int(),
	user_id: MattermostIdSchema,
	channel_id: MattermostIdSchema,
	/** Empty for a root post. */
	root_id: z.union([MattermostIdSchema, z.literal("")]),
	message: z.string(),
	/** Empty for an ordinary post; `system_*` for join/leave and other system messages. */
	type: z.string(),
	props: PropsSchema,
});
export type ApiPost = z.infer<typeof ApiPostSchema>;

/** `GET /channels/{id}/posts`: posts by id plus their order (newest first). */
export const ApiPostListSchema = z.looseObject({
	order: z.array(MattermostIdSchema),
	posts: z.record(z.string(), ApiPostSchema),
});
export type ApiPostList = z.infer<typeof ApiPostListSchema>;

export const ApiUserSchema = z.looseObject({
	id: MattermostIdSchema,
	username: z.string(),
	is_bot: z.boolean().optional().default(false),
	/** Space-separated system roles, e.g. `system_user` or `system_user system_admin`. */
	roles: z.string(),
	delete_at: z.number().int(),
});
export type ApiUser = z.infer<typeof ApiUserSchema>;

export const ApiBotSchema = z.looseObject({
	user_id: MattermostIdSchema,
	username: z.string(),
	delete_at: z.number().int(),
});
export type ApiBot = z.infer<typeof ApiBotSchema>;

export const ApiTeamSchema = z.looseObject({
	id: MattermostIdSchema,
	name: z.string(),
	delete_at: z.number().int(),
});
export type ApiTeam = z.infer<typeof ApiTeamSchema>;

export const ApiChannelSchema = z.looseObject({
	id: MattermostIdSchema,
	team_id: z.string(),
	name: z.string(),
	type: z.string(),
	delete_at: z.number().int(),
});
export type ApiChannel = z.infer<typeof ApiChannelSchema>;

/** A team or channel membership; `roles` like `channel_user` or `channel_user channel_admin`. */
export const ApiMemberSchema = z.looseObject({
	user_id: MattermostIdSchema,
	roles: z.string(),
	scheme_admin: z.boolean().optional().default(false),
});
export type ApiMember = z.infer<typeof ApiMemberSchema>;

/** True for a membership that grants more than plain membership. */
export function isElevatedMember(member: ApiMember): boolean {
	return member.scheme_admin || member.roles.split(/\s+/).some((role) => role.endsWith("_admin"));
}

export const ApiUserAccessTokenSchema = z.looseObject({
	id: z.string(),
	token: z.string().min(1),
});

export const ApiErrorSchema = z.looseObject({
	id: z.string().optional(),
	message: z.string().optional(),
});

/** A server-pushed WebSocket event (`hello`, `posted`, `post_edited`, `post_deleted`, ...). */
export const WsEventSchema = z.looseObject({
	event: z.string(),
	seq: z.number().int(),
	data: z.record(z.string(), z.json()).nullish(),
});
export type WsEvent = z.infer<typeof WsEventSchema>;

/** A reply to an action the client sent (authentication challenge, ping). */
export const WsReplySchema = z.looseObject({
	status: z.string(),
	seq_reply: z.number().int(),
});
