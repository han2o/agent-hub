import { z } from 'zod';
import {
  HandoffJobRecordSchema,
  NodeInfoSchema,
  SessionRecordSchema
} from './types.js';

export const HubEventMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    nodes: z.array(NodeInfoSchema),
    sessions: z.array(SessionRecordSchema),
    handoffs: z.array(HandoffJobRecordSchema)
  }),
  z.object({
    type: z.literal('node_update'),
    node: NodeInfoSchema
  }),
  z.object({
    type: z.literal('session_update'),
    session: SessionRecordSchema
  }),
  z.object({
    type: z.literal('handoff_update'),
    job: HandoffJobRecordSchema
  }),
  z.object({
    type: z.literal('approval_alert'),
    session: SessionRecordSchema,
    prompt: z.string()
  })
]);
export type HubEventMessage = z.infer<typeof HubEventMessageSchema>;

export const PtyClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('input'),
    data: z.string()
  }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(10).max(500),
    rows: z.number().int().min(4).max(200)
  })
]);
export type PtyClientMessage = z.infer<typeof PtyClientMessageSchema>;

export const PtyServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('output'),
    data: z.string()
  }),
  z.object({
    type: z.literal('status'),
    state: z.string(),
    message: z.string().optional()
  }),
  z.object({
    type: z.literal('exit'),
    code: z.number().int().nullable()
  })
]);
export type PtyServerMessage = z.infer<typeof PtyServerMessageSchema>;
