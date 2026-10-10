<script setup lang="ts">
import { toRefs } from "vue";
import UploadPanel from "./UploadPanel.vue";
import ExpenseList from "./ExpenseList.vue";
import PreviewToolbar from "./PreviewToolbar.vue";
import ReimbursementPages from "./ReimbursementPages.vue";
import AttachmentInspector from "./AttachmentInspector.vue";
import { useAppContext } from "../../composables/appContext";

const {
  activeTab,
  leftPanelWidth,
  commitActiveEdit,
  startLeftPanelResize,
  paperSize,
  previewViewport,
} = toRefs(useAppContext());
</script>

<template>
  <main
    v-if="activeTab === 'reimbursement'"
    class="workspace"
    :style="{ '--left-panel-width': `${leftPanelWidth}px` }"
  >
    <aside
      class="left-panel"
      @pointerdown.capture="commitActiveEdit"
      @focusin.capture="commitActiveEdit"
    >
      <UploadPanel />
      <ExpenseList />
    </aside>
    <div
      class="workspace-resizer"
      role="separator"
      aria-label="调整费用列表宽度"
      title="拖动调整费用列表宽度"
      @pointerdown="startLeftPanelResize"
    />
    <section ref="previewViewport" class="preview-panel">
      <PreviewToolbar />
      <div class="paper-stage" :style="paperSize">
        <div class="paper-scale">
          <ReimbursementPages />
        </div>
      </div>
      <AttachmentInspector />
    </section>
  </main>
</template>
