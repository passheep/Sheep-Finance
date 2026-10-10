<script setup lang="ts">
import { toRefs } from "vue";
import { useAppContext } from "../../composables/appContext";
import { formatDateTime } from "../../utils/format";
import {
  Delete,
  Plus,
  Upload,
  Download,
  Refresh,
  Folder,
  Sort,
} from "@element-plus/icons-vue";

const {
  activeTab,
  importConfiguration,
  openConfigurationImport,
  exportConfiguration,
  saveDraft,
  dataDirectory,
  loadBackupStatus,
  backupStatus,
  createDatabaseBackup,
  openBackupDirectory,
  exportFullBackup,
  importFullBackup,
  formatFileSize,
  restoreDatabaseBackup,
  cleanupLegacyArchives,
  backupLoading,
  defaultOcrProfile,
  addOcrProfile,
  ocrProfiles,
  dirty,
  makeOcrDefault,
  removeOcrProfile,
  defaultLlmProfile,
  addLlmProfile,
  llmProfiles,
  makeLlmDefault,
  removeLlmProfile,
  companyNames,
  defaultCompany,
  isDictionaryDragging,
  isDictionaryDropTarget,
  startDictionaryDrag,
  setDictionaryDefault,
  removeCompany,
  newCompany,
  addCompany,
  expenseReasons,
  defaultReason,
  removeReason,
  newReason,
  addReason,
  arrangers,
  defaultArranger,
  removeArranger,
  newArranger,
  addArranger,
  configImportInput,
} = toRefs(useAppContext());
</script>

<template>
  <section v-if="activeTab === 'settings'" class="page-shell settings-page">
    <div class="page-heading">
      <div>
        <span class="eyebrow">PREFERENCES</span>
        <h1>设置</h1>
      </div>
      <div class="settings-actions">
        <input
          ref="configImportInput"
          class="hidden-file"
          type="file"
          accept=".txt,text/plain"
          @change="importConfiguration"
        />
        <el-button @click="openConfigurationImport"
          ><Upload :size="15" />导入配置</el-button
        ><el-button @click="exportConfiguration"
          ><Download :size="15" />导出配置</el-button
        ><el-button type="primary" @click="saveDraft">保存设置</el-button>
      </div>
    </div>
    <div class="settings-grid">
      <div class="drawer-section">
        <span class="eyebrow">GENERAL</span>
        <h3>基础资料</h3>
        <el-form label-position="top">
          <el-form-item label="本地数据目录">
            <el-input
              :model-value="dataDirectory || '浏览器预览模式不生成本地数据目录'"
              readonly
            />
          </el-form-item>
        </el-form>
      </div>
      <div class="drawer-section backup-section" v-loading="backupLoading">
        <div class="drawer-section-heading">
          <div>
            <span class="eyebrow">BACKUP &amp; RECOVERY</span>
            <h3>数据备份与恢复</h3>
          </div>
          <el-button text type="primary" @click="loadBackupStatus">
            <Refresh :size="15" />刷新
          </el-button>
        </div>
        <div class="backup-summary">
          <div>
            <span>最近有效备份</span>
            <strong>{{
              backupStatus?.lastBackupAt
                ? formatDateTime(backupStatus.lastBackupAt)
                : "尚未创建"
            }}</strong>
          </div>
          <div>
            <span>有效备份</span>
            <strong>{{ backupStatus?.validBackupCount ?? 0 }} / 5</strong>
          </div>
          <div>
            <span>自动备份</span>
            <strong>{{
              backupStatus?.backupDue ? "本次启动已到期" : "72 小时检查"
            }}</strong>
          </div>
        </div>
        <div class="backup-actions">
          <el-button type="primary" @click="createDatabaseBackup">
            <Download :size="15" />立即备份
          </el-button>
          <el-button @click="openBackupDirectory">
            <Folder :size="15" />打开备份目录
          </el-button>
          <el-button @click="exportFullBackup">导出完整备份</el-button>
          <el-button @click="importFullBackup">导入完整备份</el-button>
        </div>
        <div v-if="backupStatus?.backups.length" class="backup-list">
          <div v-for="item in backupStatus.backups" :key="item.fileName">
            <span class="backup-list-main">
              <strong>{{ formatDateTime(item.createdAt) }}</strong>
              <small
                >{{ formatFileSize(item.sizeBytes) }} ·
                {{ item.fileName }}</small
              >
            </span>
            <el-tag
              :type="item.valid && item.imagesComplete ? 'success' : 'danger'"
              >{{
                item.valid && item.imagesComplete ? "可恢复" : "校验失败"
              }}</el-tag
            >
            <el-button
              text
              type="primary"
              :disabled="!item.valid || !item.imagesComplete"
              @click="restoreDatabaseBackup(item)"
              >恢复</el-button
            >
          </div>
        </div>
        <div v-if="backupStatus?.legacyArchives.length" class="legacy-summary">
          <span>
            已保留 {{ backupStatus.legacyArchives.length }} 个旧 JSON 归档，共
            {{
              formatFileSize(
                backupStatus.legacyArchives.reduce(
                  (sum, item) => sum + item.sizeBytes,
                  0,
                ),
              )
            }}
          </span>
          <el-button
            text
            type="danger"
            :disabled="!backupStatus.validBackupCount"
            @click="cleanupLegacyArchives"
            >手工清理</el-button
          >
        </div>
        <p class="drawer-help">
          数据库备份和完整 ZIP 均包含
          OCR/大模型密钥，请按敏感文件保管。自动备份仅保留最近 5 份有效快照。
        </p>
      </div>
      <div class="drawer-section">
        <div class="drawer-section-heading">
          <div>
            <span class="eyebrow">OCR</span>
            <h3>
              阿里云 OCR 配置
              <small class="drawer-current"
                >当前：{{ defaultOcrProfile?.name }}</small
              >
            </h3>
          </div>
          <el-button text type="primary" @click="addOcrProfile"
            ><Plus :size="15" />新增配置</el-button
          >
        </div>
        <p class="drawer-help">
          默认使用全文识别高精版；勾选手写体后由对应费用项选择手写接口。密钥只保存在本机配置中。
        </p>
        <div class="service-list">
          <article
            v-for="profile in ocrProfiles"
            :key="profile.id"
            class="service-editor"
            :class="{ default: profile.isDefault }"
          >
            <div class="service-editor-head">
              <el-input
                v-model="profile.name"
                placeholder="配置名称"
                @change="dirty"
              /><el-tag v-if="profile.isDefault" type="success">默认</el-tag
              ><el-button
                v-else
                text
                type="primary"
                @click="makeOcrDefault(profile)"
                >设为默认</el-button
              ><el-button text type="danger" @click="removeOcrProfile(profile)"
                >删除</el-button
              >
            </div>
            <div class="service-grid">
              <el-input
                v-model="profile.endpoint"
                class="service-wide"
                placeholder="服务地址"
                @change="dirty"
              /><el-input
                v-model="profile.region"
                placeholder="区域，如 cn-hangzhou"
                @change="dirty"
              /><el-input
                v-model="profile.timeoutSeconds"
                type="number"
                min="5"
                max="180"
                placeholder="超时（秒）"
                @change="dirty"
              /><el-input
                v-model="profile.accessKeyId"
                placeholder="AccessKey ID"
                @change="dirty"
              /><el-input
                v-model="profile.accessKeySecret"
                type="password"
                show-password
                placeholder="AccessKey Secret"
                @change="dirty"
              />
            </div>
          </article>
        </div>
      </div>
      <div class="drawer-section">
        <div class="drawer-section-heading">
          <div>
            <span class="eyebrow">LLM</span>
            <h3>
              大模型配置
              <small class="drawer-current"
                >当前：{{ defaultLlmProfile?.name }}</small
              >
            </h3>
          </div>
          <el-button text type="primary" @click="addLlmProfile"
            ><Plus :size="15" />新增配置</el-button
          >
        </div>
        <p class="drawer-help">
          OCR
          完成后，软件会把原文和启用的事由字典交给这里选中的模型做结构化提取。
        </p>
        <div class="service-list">
          <article
            v-for="profile in llmProfiles"
            :key="profile.id"
            class="service-editor"
            :class="{ default: profile.isDefault }"
          >
            <div class="service-editor-head">
              <el-input
                v-model="profile.name"
                placeholder="配置名称"
                @change="dirty"
              /><el-tag v-if="profile.isDefault" type="success">默认</el-tag
              ><el-button
                v-else
                text
                type="primary"
                @click="makeLlmDefault(profile)"
                >设为默认</el-button
              ><el-button text type="danger" @click="removeLlmProfile(profile)"
                >删除</el-button
              >
            </div>
            <div class="service-grid">
              <el-input
                v-model="profile.baseUrl"
                class="service-wide"
                placeholder="Base URL，如 https://api.deepseek.com/v1"
                @change="dirty"
              /><el-input
                v-model="profile.model"
                placeholder="模型名称"
                @change="dirty"
              /><el-input
                v-model="profile.timeoutSeconds"
                type="number"
                min="5"
                max="180"
                placeholder="超时（秒）"
                @change="dirty"
              /><el-input
                v-model="profile.apiKey"
                type="password"
                show-password
                placeholder="API Key"
                @change="dirty"
              />
              <label class="service-switch service-wide">
                <span>
                  <strong>是否多模态</strong>
                  <small>开启后会把识别图片与 OCR 文本一并发送给模型</small>
                </span>
                <el-switch v-model="profile.multimodal" @change="dirty" />
              </label>
            </div>
          </article>
        </div>
      </div>
      <div class="drawer-section">
        <div class="drawer-section-heading">
          <div>
            <span class="eyebrow">DICTIONARIES</span>
            <h3>字典项</h3>
          </div>
        </div>
        <p class="drawer-help">
          拖动每项左侧的排序图标调整顺序；选中的默认值会自动带入新上传的费用。
        </p>
        <p class="drawer-help configuration-transfer-help">
          导出的 TXT 会进行轻量加密，可在另一台报销单助手
          电脑上一键导入；请仍将其作为含密钥文件妥善保管。
        </p>
        <div class="dictionary-group">
          <h4>公司名称字典</h4>
          <div class="dictionary-options" data-dictionary-type="company">
            <div
              v-for="(company, index) in companyNames"
              :key="company"
              class="dictionary-option"
              :class="{
                default: company === defaultCompany,
                dragging: isDictionaryDragging('company', company),
                'drop-before': isDictionaryDropTarget(
                  'company',
                  company,
                  'before',
                ),
                'drop-after': isDictionaryDropTarget(
                  'company',
                  company,
                  'after',
                ),
              }"
              :data-dictionary-index="index"
              :data-dictionary-value="company"
              @pointerdown="startDictionaryDrag($event, 'company', company)"
            >
              <span
                class="dictionary-drag-handle"
                title="按住拖动调整顺序"
                @pointerdown="startDictionaryDrag($event, 'company', company)"
                ><Sort :size="14"
              /></span>
              <el-radio
                :model-value="defaultCompany"
                :value="company"
                @change="setDictionaryDefault('company', company)"
                >{{ company }}</el-radio
              >
              <el-button
                circle
                text
                type="danger"
                :icon="Delete"
                title="删除公司名称"
                @click="removeCompany(company)"
              />
            </div>
          </div>
          <div class="dictionary-add-row">
            <el-input
              v-model="newCompany"
              placeholder="添加公司名称，回车确认"
              @keyup.enter="addCompany"
            />
            <el-button
              circle
              type="primary"
              :icon="Plus"
              title="添加公司名称"
              @click="addCompany"
            />
          </div>
        </div>
        <div class="dictionary-group">
          <h4>事由字典</h4>
          <div class="dictionary-options" data-dictionary-type="reason">
            <div
              v-for="(reason, index) in expenseReasons"
              :key="reason"
              class="dictionary-option"
              :class="{
                default: reason === defaultReason,
                dragging: isDictionaryDragging('reason', reason),
                'drop-before': isDictionaryDropTarget(
                  'reason',
                  reason,
                  'before',
                ),
                'drop-after': isDictionaryDropTarget('reason', reason, 'after'),
              }"
              :data-dictionary-index="index"
              :data-dictionary-value="reason"
              @pointerdown="startDictionaryDrag($event, 'reason', reason)"
            >
              <span
                class="dictionary-drag-handle"
                title="按住拖动调整顺序"
                @pointerdown="startDictionaryDrag($event, 'reason', reason)"
                ><Sort :size="14"
              /></span>
              <el-radio
                :model-value="defaultReason"
                :value="reason"
                @change="setDictionaryDefault('reason', reason)"
                >{{ reason }}</el-radio
              >
              <el-button
                circle
                text
                type="danger"
                :icon="Delete"
                title="删除事由"
                @click="removeReason(reason)"
              />
            </div>
          </div>
          <div class="dictionary-add-row">
            <el-input
              v-model="newReason"
              placeholder="添加事由，回车确认"
              @keyup.enter="addReason"
            />
            <el-button
              circle
              type="primary"
              :icon="Plus"
              title="添加事由"
              @click="addReason"
            />
          </div>
        </div>
        <div class="dictionary-group">
          <h4>安排人字典</h4>
          <div class="dictionary-options" data-dictionary-type="arranger">
            <div
              v-for="(arranger, index) in arrangers"
              :key="arranger"
              class="dictionary-option"
              :class="{
                default: arranger === defaultArranger,
                dragging: isDictionaryDragging('arranger', arranger),
                'drop-before': isDictionaryDropTarget(
                  'arranger',
                  arranger,
                  'before',
                ),
                'drop-after': isDictionaryDropTarget(
                  'arranger',
                  arranger,
                  'after',
                ),
              }"
              :data-dictionary-index="index"
              :data-dictionary-value="arranger"
              @pointerdown="startDictionaryDrag($event, 'arranger', arranger)"
            >
              <span
                class="dictionary-drag-handle"
                title="按住拖动调整顺序"
                @pointerdown="startDictionaryDrag($event, 'arranger', arranger)"
                ><Sort :size="14"
              /></span>
              <el-radio
                :model-value="defaultArranger"
                :value="arranger"
                @change="setDictionaryDefault('arranger', arranger)"
                >{{ arranger }}</el-radio
              >
              <el-button
                circle
                text
                type="danger"
                :icon="Delete"
                title="删除安排人"
                @click="removeArranger(arranger)"
              />
            </div>
          </div>
          <div class="dictionary-add-row">
            <el-input
              v-model="newArranger"
              placeholder="添加安排人，回车确认"
              @keyup.enter="addArranger"
            />
            <el-button
              circle
              type="primary"
              :icon="Plus"
              title="添加安排人"
              @click="addArranger"
            />
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
