<script setup lang="ts">
interface AttachmentTransform {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  cropZoom: number;
  cropX: number;
  cropY: number;
}

interface AttachmentItem {
  id: string;
  expenseId: string;
  fileName: string;
  imageDataUrl: string;
  label: string;
  transform: AttachmentTransform;
}

defineProps<{
  attachments: AttachmentItem[];
  pageIndex: number;
  selectedId: string | null;
}>();

const emit = defineEmits<{
  select: [attachment: AttachmentItem];
  pointerStart: [
    event: PointerEvent,
    attachment: AttachmentItem,
    type: "move" | "resize",
    pageIndex: number,
  ];
}>();
</script>

<template>
  <div
    class="attachment-area"
    :class="{
      'active-attachment-area': attachments.some(
        (attachment) => attachment.id === selectedId,
      ),
    }"
    :data-attachment-page-index="pageIndex"
    data-export-attachment-page
  >
    <div v-if="!attachments.length" class="attachment-empty">
      图片会按费用顺序排列在这里
    </div>
    <div
      v-for="attachment in attachments"
      :key="attachment.id"
      :data-attachment-id="attachment.id"
      :data-expense-id="attachment.expenseId"
      class="attachment-object"
      :class="{ selected: attachment.id === selectedId }"
      :style="{
        left: `${attachment.transform.x}%`,
        top: `${attachment.transform.y}%`,
        width: `${attachment.transform.width}%`,
        height: `${attachment.transform.height}%`,
        transform: `rotate(${attachment.transform.rotation}deg)`,
      }"
      @pointerdown="emit('pointerStart', $event, attachment, 'move', pageIndex)"
      @click.stop="emit('select', attachment)"
    >
      <img
        :src="attachment.imageDataUrl"
        :alt="attachment.fileName"
        :style="{
          transform: `scale(${attachment.transform.cropZoom})`,
          transformOrigin: `${attachment.transform.cropX}% ${attachment.transform.cropY}%`,
          objectPosition: `${attachment.transform.cropX}% ${attachment.transform.cropY}%`,
        }"
      />
      <span class="attachment-label">{{ attachment.label }}</span>
      <span
        v-if="attachment.id === selectedId"
        class="resize-handle"
        @pointerdown.stop="
          emit('pointerStart', $event, attachment, 'resize', pageIndex)
        "
      />
    </div>
  </div>
</template>
