<script setup lang="ts">
import { toRefs } from "vue";
import { useAppContext } from "../../composables/appContext";

const { activeTab, openExternalUrl, dataDirectory } = toRefs(useAppContext());
</script>

<template>
  <section v-if="activeTab === 'about'" class="page-shell about-page">
    <img
      class="about-mark"
      src="/app-icon.png"
      alt="报销单助手应用图标"
      width="112"
      height="112"
    />
    <div>
      <span class="eyebrow">报销单助手</span>
      <h1>报销单助手</h1>
      <p>将票据截图识别、核对并排版为报销单的本地桌面工具。</p>
      <div class="about-meta">
        <span>版本 0.3.0</span><span>Windows 10 x64</span>
      </div>
      <div class="about-links">
        <el-link
          href="https://github.com/passheep/Sheep-Finance"
          type="primary"
          @click.prevent="
            openExternalUrl('https://github.com/passheep/Sheep-Finance')
          "
          >GitHub 开源仓库</el-link
        >
        <span>联系 QQ：903081605</span>
      </div>
      <div v-if="dataDirectory" class="about-path">
        <span>数据目录</span><strong>{{ dataDirectory }}</strong>
      </div>
    </div>
  </section>
</template>
