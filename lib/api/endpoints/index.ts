import { conversationCreate, conversationDelete, conversationExport, conversationRead, messageFlag, messagePost, messageResearch } from "@/lib/api/endpoints/assistant";
import { auditExportCreate, auditExportEstimate, auditExportRead } from "@/lib/api/endpoints/audit";
import { authBackchannel, authCallback, authDev, authLogin, authLogout } from "@/lib/api/endpoints/auth";
import { evidenceAdd, evidenceDelete, evidenceUploadCreate } from "@/lib/api/endpoints/evidence";
import { chapterHistory, chapterHistoryExport } from "@/lib/api/endpoints/history";
import { chapterByNumber, chaptersList, figureDerive, releasesCurrent, search, sectionById } from "@/lib/api/endpoints/content";
import { curationDecision, curationMetrics, curationQueue, curationRecheck } from "@/lib/api/endpoints/curation";
import { proposalEndorse, proposalWithdraw } from "@/lib/api/endpoints/proposals";
import { me, meSessionDelete, meSessions } from "@/lib/api/endpoints/me";
import { suggestionRecord, suggestionRecordExport } from "@/lib/api/endpoints/record";
import { researchConversationCreate, researchConversationDelete, researchConversationExport, researchConversationRead, researchRunFlag, researchRunRead, researchRunStart } from "@/lib/api/endpoints/research";
import { researchFindingDraft, researchFindingPropose } from "@/lib/api/endpoints/researchFindings";
import { bookmarkDelete, bookmarkPut, noteDelete, notePut, pathProgress, pathsList } from "@/lib/api/endpoints/reader";
import { rubricByVersion, rubricCurrent } from "@/lib/api/endpoints/rubric";
import { objectGet, objectPut } from "@/lib/api/endpoints/storage";
import { suggestionCreate, suggestionDelete, suggestionPatch, suggestionRead, suggestionSubmit, suggestionWithdraw } from "@/lib/api/endpoints/suggestions";
import type { EndpointSpec } from "@/lib/api/handler";

/** Every endpoint of the API, for the OpenAPI document and the contract tests (feature-specs/09 § 6.2). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALL_ENDPOINTS: ReadonlyArray<EndpointSpec<any, any, any, any, any>> = [
  releasesCurrent,
  chaptersList,
  chapterByNumber,
  sectionById,
  figureDerive,
  chapterHistory,
  chapterHistoryExport,
  auditExportCreate,
  auditExportEstimate,
  auditExportRead,
  search,
  pathsList,
  pathProgress,
  bookmarkPut,
  bookmarkDelete,
  notePut,
  noteDelete,
  authLogin,
  authCallback,
  authLogout,
  authBackchannel,
  authDev,
  me,
  meSessions,
  meSessionDelete,
  conversationCreate,
  conversationRead,
  conversationDelete,
  messagePost,
  messageFlag,
  messageResearch,
  conversationExport,
  researchConversationCreate,
  researchConversationRead,
  researchConversationDelete,
  researchRunStart,
  researchRunRead,
  researchRunFlag,
  researchConversationExport,
  researchFindingDraft,
  researchFindingPropose,
  rubricCurrent,
  rubricByVersion,
  suggestionCreate,
  suggestionRead,
  suggestionPatch,
  suggestionDelete,
  suggestionSubmit,
  suggestionWithdraw,
  suggestionRecord,
  suggestionRecordExport,
  curationQueue,
  curationDecision,
  proposalEndorse,
  proposalWithdraw,
  curationRecheck,
  curationMetrics,
  evidenceUploadCreate,
  evidenceAdd,
  evidenceDelete,
  objectPut,
  objectGet,
];
