// pages/profile/profile.ts — 最小个人档案（任务 14）。
//
// 单一职责：让用户在本机填写/修改/清除一份个人档案，供后续本地整理与摘要复用。
// 数据层：shared/services/records 的 `profile` 单例 store（键 records_profile，
//   运行期命名空间 mhp_）。本页只调用 records.profile.*，不直接读写 storage，
//   也不引用旧实现留下的任何键——旧页面已随本任务整体删除。
//
// 字段（冻结，不增不减）：称呼 name / 年龄段 ageRange / 性别 gender（可选）/
//   过敏 allergies / 长期用药 medications / 既往情况 history。
//   本页不含任何把档案拼进模型提示词的文案或字段，仅做本地存储与展示。
//
// 校验：服务端（records）不做字段校验，故「称呼与年龄段至少填一项」的守卫在
//   本页完成——二者 trim() 后均为空时给出提示并**不写入任何存储**。
//
// 写入策略（单例语义）：已存在记录 -> update(existing.id, 六字段 patch)；
//   否则 -> add(input)。清除 -> remove(existing.id) 回到空态。
//
// 界面微文案（如「请至少填写称呼或年龄段」）为短语，随本页内联；集中维护的
//   长文案与字段/按钮标签仍来自 config/texts.ts（LABELS / BUTTONS）。

import { BUTTONS, LABELS } from '../../config/texts';
import { A11Y_DATA, syncA11y } from '../../shared/ui/a11y';
import { SIDEBAR_DATA, setSidebarCollapsed, syncSidebar } from '../../shared/ui/sidebar';
import { records } from '../../shared/services/records';
import type { LocalProfile, LocalProfileInput } from '../../shared/services/records';

/** 表单六字段；gender 为空串表示未填写（可选）。 */
interface ProfileForm {
  name: string;
  ageRange: string;
  gender: string;
  allergies: string;
  medications: string;
  history: string;
}

const EMPTY_FORM: ProfileForm = {
  name: '',
  ageRange: '',
  gender: '',
  allergies: '',
  medications: '',
  history: '',
};

/** 年龄段候选项：用区间代替精确年龄（picker selector mode）。 */
const AGE_RANGES: string[] = ['0-17', '18-39', '40-59', '60-69', '70-79', '80 及以上'];

/** picker 未选择时的占位文案。 */
const AGE_RANGE_PLACEHOLDER = '请选择年龄段';

// 界面微文案（短提示；非需集中的长文案）。
const REQUIRED_HINT = '请至少填写称呼或年龄段';
const SAVED_HINT = '档案已保存';
const CLEARED_HINT = '档案已清除';
const CLEAR_CONFIRM_TITLE = '清除档案';
const CLEAR_CONFIRM_CONTENT = '将删除本机保存的个人档案，确定继续？';

function pad2(value: number): string {
  return value < 10 ? '0' + value : String(value);
}

/** ISO -> `YYYY-MM-DD HH:mm`；无法解析时返回空串（不伪造时间）。 */
function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

/** 记录 -> 表单。 */
function formFromRecord(record: LocalProfile): ProfileForm {
  return {
    name: record.name,
    ageRange: record.ageRange,
    gender: record.gender === undefined ? '' : record.gender,
    allergies: record.allergies,
    medications: record.medications,
    history: record.history,
  };
}

/** 表单 -> 存储输入（去掉首尾空白；gender 可空）。 */
function inputFromForm(form: ProfileForm): LocalProfileInput {
  return {
    name: form.name.trim(),
    ageRange: form.ageRange.trim(),
    gender: form.gender,
    allergies: form.allergies.trim(),
    medications: form.medications.trim(),
    history: form.history.trim(),
  };
}

/** 不可变更新单个表单字段。 */
function setFormField(form: ProfileForm, key: keyof ProfileForm, value: string): ProfileForm {
  const next: ProfileForm = { ...form };
  next[key] = value;
  return next;
}

Page({
  data: {
    ...A11Y_DATA,
    ...SIDEBAR_DATA,
    form: { ...EMPTY_FORM } as ProfileForm,
    ageRanges: AGE_RANGES,
    ageRangeIndex: -1,
    ageRangePlaceholder: AGE_RANGE_PLACEHOLDER,
    genderOptions: [
      { value: '男', label: '男' },
      { value: '女', label: '女' },
    ],
    hasRecord: false,
    recordId: '',
    createdAtLabel: '',
    updatedAtLabel: '',
    errorText: '',
    labels: LABELS,
    saveText: BUTTONS.save,
    clearText: BUTTONS.delete,
  },

  onShow() {
    syncA11y(this);
    syncSidebar(this);
    if (typeof wx.setNavigationBarColor === 'function') {
      const hc = this.data.highContrast === true;
      wx.setNavigationBarColor({
        frontColor: hc ? '#ffffff' : '#000000',
        backgroundColor: hc ? '#000000' : '#ffffff',
      });
    }
    this.load();
  },

  /** 侧栏收起/展开：落盘偏好并回写 data。 */
  onSidebarToggle() {
    this.setData(setSidebarCollapsed(!this.data.sidebarCollapsed));
  },

  /** 从单例 store 读取（0..1 条）并刷新表单与时间戳。 */
  load() {
    const existing = records.profile.list();
    const record: LocalProfile | null = existing.length > 0 ? existing[0] : null;
    if (record === null) {
      this.setData({
        form: { ...EMPTY_FORM },
        ageRangeIndex: -1,
        hasRecord: false,
        recordId: '',
        createdAtLabel: '',
        updatedAtLabel: '',
        errorText: '',
      });
      return;
    }
    const form = formFromRecord(record);
    const index = AGE_RANGES.indexOf(form.ageRange);
    this.setData({
      form,
      ageRangeIndex: index,
      hasRecord: true,
      recordId: record.id,
      createdAtLabel: formatStamp(record.createdAt),
      updatedAtLabel: formatStamp(record.updatedAt),
      errorText: '',
    });
  },

  onFieldInput(event: WechatMiniprogram.Input) {
    const key = event.currentTarget.dataset.key as keyof ProfileForm;
    const value = event.detail.value;
    this.setData({ form: setFormField(this.data.form, key, value), errorText: '' });
  },

  /** 性别按钮：再点当前项则取消（保持可选）。 */
  setGender(event: WechatMiniprogram.TouchEvent) {
    const value = event.currentTarget.dataset.value as string;
    const next = this.data.form.gender === value ? '' : value;
    this.setData({ form: setFormField(this.data.form, 'gender', next), errorText: '' });
    if (typeof wx.vibrateShort === 'function') wx.vibrateShort({ type: 'light' });
  },

  onAgeRangeChange(event: WechatMiniprogram.PickerChange) {
    const index = parseInt(String(event.detail.value), 10);
    if (Number.isNaN(index) || index < 0 || index >= AGE_RANGES.length) return;
    this.setData({
      ageRangeIndex: index,
      form: setFormField(this.data.form, 'ageRange', AGE_RANGES[index]),
      errorText: '',
    });
  },

  /**
   * 保存：称呼与年龄段 trim 后均为空时不写入（守卫 + 提示）；
   * 否则已有记录走 update，无记录走 add，成功后回读刷新时间戳。
   */
  onSave() {
    const form = this.data.form;
    const name = form.name.trim();
    const ageRange = form.ageRange.trim();
    if (name === '' && ageRange === '') {
      this.setData({ errorText: REQUIRED_HINT });
      if (typeof wx.showToast === 'function') wx.showToast({ title: REQUIRED_HINT, icon: 'none' });
      return;
    }

    const input = inputFromForm(form);
    const existing = records.profile.list();
    if (existing.length > 0) {
      records.profile.update(existing[0].id, input);
    } else {
      records.profile.add(input);
    }

    this.load();
    if (typeof wx.vibrateShort === 'function') wx.vibrateShort({ type: 'light' });
    if (typeof wx.showToast === 'function') wx.showToast({ title: SAVED_HINT, icon: 'success' });
  },

  /** 清除：确认后 remove 当前记录并回到空态。 */
  onClear() {
    const doClear = () => {
      const existing = records.profile.list();
      if (existing.length > 0) records.profile.remove(existing[0].id);
      this.setData({
        form: { ...EMPTY_FORM },
        ageRangeIndex: -1,
        hasRecord: false,
        recordId: '',
        createdAtLabel: '',
        updatedAtLabel: '',
        errorText: '',
      });
      if (typeof wx.showToast === 'function') wx.showToast({ title: CLEARED_HINT, icon: 'none' });
    };

    if (typeof wx.showModal === 'function') {
      wx.showModal({
        title: CLEAR_CONFIRM_TITLE,
        content: CLEAR_CONFIRM_CONTENT,
        success: (res) => {
          if (res.confirm) doClear();
        },
      });
    } else {
      doClear();
    }
  },
});
