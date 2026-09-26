-- Active reply waits created before thread binding: bind them to the threads of their run's
-- posts in the waited-on conversation (none found: bound to no thread, i.e. fail closed).
UPDATE "wait_subscriptions" w SET "thread_root_ids" = coalesce((
	SELECT jsonb_agg(DISTINCT coalesce(e->'data'->>'root_id', e->'data'->>'post_id'))
	  FROM "context_snapshots" s,
	       jsonb_array_elements(jsonb_build_array(s."input"->'trigger') || coalesce(s."input"->'pendingInbox', '[]'::jsonb)) e
	 WHERE s."run_id" = w."created_by_run_id"
	   AND e->>'correlationid' = w."correlation_id"
	   AND e->>'type' IN ('mattermost.post.created', 'mattermost.agent.mentioned', 'mattermost.thread.reply')
	   AND e->'data' ? 'post_id'
), '[]'::jsonb)
 WHERE w."status" = 'active' AND w."event_type" = 'mattermost.thread.reply';
