/**
 * shared/services/demoAi.ts — 演示模式确定性 fixtures（任务 32）。
 *
 * 纯数据 + 纯函数：不接触任何宿主接口、无网络、无任何密钥；同一输入永远返回同一份
 * 内容。内容语义对齐 server/demo-fixtures.json（任务 26），供 pages/ai 在演示模式打开
 * 时替换 sendAsk / sendExtractMemory 的传输结果。
 */

import { MAX_INTERVIEW_QUESTIONS } from './aiClient';
import type { AskInput, ExtractInput, InterviewInput, SendSuccess } from './aiClient';

const ORGANIZE_DATA = {
  points: ['近一周出现头痛', '入睡较晚、睡眠欠佳'],
  extracted: {
    symptoms: ['头痛'],
    medications: [],
    allergies: [],
    history: [],
    exams: [],
  },
  unknowns: ['头痛诱因与持续时间未说明'],
  questions: ['头痛从何时开始、多久一次？'],
};

const CONSULT_DATA = {
  directions: [
    {
      text: '注意休息与规律作息',
      citation: {
        title: '国家卫生健康委员会：就医准备与信息整理提示',
        url: 'https://nhc.gov.cn/health/demo-1',
        domain: 'nhc.gov.cn',
      },
    },
    {
      text: '保持清淡均衡饮食',
      citation: {
        title: '中国疾病预防控制中心：日常健康生活方式提示',
        url: 'https://www.chinacdc.cn/health/demo-2',
        domain: 'www.chinacdc.cn',
      },
    },
  ],
  suggestedDepartments: ['全科'],
  citations: [
    {
      title: '国家卫生健康委员会：就医准备与信息整理提示',
      url: 'https://nhc.gov.cn/health/demo-1',
      domain: 'nhc.gov.cn',
    },
    {
      title: '中国疾病预防控制中心：日常健康生活方式提示',
      url: 'https://www.chinacdc.cn/health/demo-2',
      domain: 'www.chinacdc.cn',
    },
  ],
  suggestions: [
    {
      text: '作息规律、避免熬夜',
      citation: {
        title: '国家卫生健康委员会：就医准备与信息整理提示',
        url: 'https://nhc.gov.cn/health/demo-1',
        domain: 'nhc.gov.cn',
      },
    },
  ],
  unknowns: ['症状出现时间与频率'],
  questions: ['需要向医生了解哪些检查或注意事项？'],
  disclaimer: '以上内容仅为信息整理与一般性提示，不构成诊断或治疗建议；如有不适请及时就医。',
};

const EXTRACT_CANDIDATES = [
  { text: '偏好晚上十点前入睡' },
  { text: '饮食清淡、少油少盐' },
  { text: '喜欢散步等轻度活动' },
];

const MAX_DEMO_CANDIDATES = 3;

function cloneData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** /api/ask 的确定性成功结果：consult 模式返回问诊 fixture，否则返回整理 fixture。 */
export function demoAsk(input: AskInput): SendSuccess {
  const data = input.mode === 'consult' ? CONSULT_DATA : ORGANIZE_DATA;
  return { ok: true, status: 200, data: cloneData(data) };
}

/** /api/extract-memory 的确定性成功结果：最多 3 条偏好候选。 */
export function demoExtractMemory(input: ExtractInput = { messages: [] }): SendSuccess {
  const requested =
    typeof input.maxItems === 'number' && Number.isFinite(input.maxItems)
      ? Math.floor(input.maxItems)
      : MAX_DEMO_CANDIDATES;
  const count = requested > 0 ? Math.min(requested, MAX_DEMO_CANDIDATES) : MAX_DEMO_CANDIDATES;
  return { ok: true, status: 200, data: { candidates: cloneData(EXTRACT_CANDIDATES.slice(0, count)) } };
}

/** 演示模式的问诊引导：固定同一个追问；达到轮数上限时返回 done（与服务端一致）。 */
const INTERVIEW_ASK = {
  status: 'ask',
  question: { text: '这个情况大概持续多久了？', slot: 'duration' },
};

export function demoInterview(input: InterviewInput = { messages: [] }): SendSuccess {
  const round =
    typeof input.round === 'number' && Number.isFinite(input.round) && input.round >= 0
      ? Math.floor(input.round)
      : 0;
  const data = round >= MAX_INTERVIEW_QUESTIONS ? { status: 'done' } : INTERVIEW_ASK;
  return { ok: true, status: 200, data: cloneData(data) };
}
