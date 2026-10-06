/**
 * config/lexicon.ts — 常见医学词的白话词义表（meaning-only）。
 *
 * 仅解释词义，用于帮助用户读懂自己的记录；不含任何诊断、用药、剂量、效果
 * 或推荐类内容。查词请用 `lexiconFor(term)`；未命中返回 undefined。
 *
 * 结构：
 *   interface LexEntry { term: string; explain: string }
 *   const LEXICON: LexEntry[]
 *   function lexiconFor(term: string): LexEntry | undefined
 */

export interface LexEntry {
  term: string;
  explain: string;
}

export const LEXICON: LexEntry[] = [
  { term: '血压', explain: '血液对血管壁的压力，通常用两个数值表示。' },
  { term: '高血压', explain: '血压长期高于一般范围的一种状况。' },
  { term: '低血压', explain: '血压长期低于一般范围的一种状况。' },
  { term: '血糖', explain: '血液中的葡萄糖含量。' },
  { term: '糖尿病', explain: '血糖长期偏高的一种代谢状况。' },
  { term: '心率', explain: '心脏每分钟跳动的次数。' },
  { term: '脉搏', explain: '在动脉上能感觉到的跳动，一般与心率一致。' },
  { term: '体温', explain: '身体内部的温度。' },
  { term: '发热', explain: '体温高于平时范围的状态，俗称发烧。' },
  { term: '咳嗽', explain: '呼吸道受刺激时快速呼气，用来清除异物或分泌物。' },
  { term: '咳痰', explain: '咳嗽时排出呼吸道分泌物的动作。' },
  { term: '头痛', explain: '头部出现的疼痛感觉。' },
  { term: '头晕', explain: '感觉自身或周围晃动、站立不稳。' },
  { term: '恶心', explain: '想吐的不适感。' },
  { term: '呕吐', explain: '胃里的内容物经口排出。' },
  { term: '腹泻', explain: '排便次数增多、粪便稀薄。' },
  { term: '便秘', explain: '排便次数减少或排便费力。' },
  { term: '腹痛', explain: '腹部出现的疼痛感觉。' },
  { term: '皮疹', explain: '皮肤上出现的颜色或形态改变，如红斑、丘疹。' },
  { term: '湿疹', explain: '皮肤发红、发痒、起屑的一种炎症表现。' },
  { term: '过敏', explain: '身体对某些物质反应过度，如起疹、打喷嚏。' },
  { term: '鼻炎', explain: '鼻腔黏膜发炎的统称。' },
  { term: '咽炎', explain: '咽部黏膜发炎。' },
  { term: '支气管炎', explain: '支气管出现炎症。' },
  { term: '哮喘', explain: '气道反复变窄、呼气费力的一种长期状况。' },
  { term: '胃炎', explain: '胃黏膜出现炎症。' },
  { term: '胃溃疡', explain: '胃黏膜出现破损。' },
  { term: '胃食管反流', explain: '胃内内容物反流到食管的现象。' },
  { term: '冠心病', explain: '给心脏供血的血管变窄或堵塞所引起的心脏问题。' },
  { term: '心肌梗死', explain: '心脏供血突然中断导致心肌受损的一种急症。' },
  { term: '脑卒中', explain: '脑部血流突然中断或出血引起的情况，俗称中风。' },
  { term: '贫血', explain: '血液携带氧气的能力下降的一种状况。' },
  { term: '甲状腺', explain: '颈部前方的一个腺体，参与调节身体的代谢。' },
  { term: '甲亢', explain: '甲状腺功能偏高的状况。' },
  { term: '甲减', explain: '甲状腺功能偏低的状况。' },
  { term: '关节炎', explain: '关节出现炎症或疼痛的状况。' },
  { term: '骨质疏松', explain: '骨密度下降、骨头变脆的状况。' },
  { term: '失眠', explain: '入睡或维持睡眠困难。' },
  { term: '焦虑', explain: '紧张不安、担心过多的情绪状态。' },
  { term: '抑郁', explain: '持续情绪低落、兴趣减退的状态。' },
  { term: '血脂', explain: '血液中的脂肪类物质，如胆固醇和甘油三酯。' },
  { term: '尿酸', explain: '血液中的一种代谢产物，偏高与痛风相关。' },
  { term: '肝功能', explain: '反映肝脏工作情况的化验指标。' },
  { term: '肾功能', explain: '反映肾脏过滤功能的化验指标。' },
  { term: '血常规', explain: '检查血细胞数量和形态的常用化验。' },
  { term: '尿常规', explain: '检查尿液成分的常用化验。' },
  { term: '心电图', explain: '记录心脏电活动的检查。' },
  { term: 'B超', explain: '用超声波查看体内器官形态的检查。' },
  { term: 'CT', explain: '用射线分层成像的检查。' },
  { term: '核磁共振', explain: '用磁场和无线电波成像的检查，通常简称 MRI。' },
  { term: '胃镜', explain: '把细管经口伸入，直接查看食管和胃内部的检查。' },
  { term: '活检', explain: '取一小块组织做进一步化验的检查。' },
  { term: '疫苗', explain: '帮助身体提前建立免疫记忆的生物制品。' },
  { term: '抗生素', explain: '用于对付细菌感染的一类药物。' },
  { term: '消炎药', explain: '减轻炎症反应的一类药物统称。' },
  { term: '退烧药', explain: '用于降低体温的一类药物。' },
  { term: '输液', explain: '把液体和药物经静脉输入体内。' },
  { term: '雾化', explain: '把药液变成细小雾滴后吸入的方式。' },
];

/** 按词取解释；未收录返回 undefined。 */
export function lexiconFor(term: string): LexEntry | undefined {
  return LEXICON.find((e) => e.term === term);
}
