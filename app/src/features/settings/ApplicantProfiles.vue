<script setup lang="ts">
import { toRefs } from "vue";
import { useAppContext } from "../../composables/appContext";
import { Plus } from "@element-plus/icons-vue";

const { activeTab, addProfile, profiles, dirty, setDefault, removeProfile } =
  toRefs(useAppContext());
</script>

<template>
  <section v-if="activeTab === 'settings'" class="page-shell profiles-page">
    <div class="profile-drawer-head">
      <div>
        <span class="eyebrow">PROFILES</span>
        <h2>申请人</h2>
        <p>
          新建报销单时自动带出默认申请人的部门与收款信息，单据内修改不会回写这里。
        </p>
      </div>
      <el-button type="primary" plain @click="addProfile"
        ><Plus :size="15" />新增申请人</el-button
      >
    </div>
    <div class="profiles-list">
      <article
        v-for="profile in profiles"
        :key="profile.id"
        class="profile-editor"
        :class="{ default: profile.isDefault }"
      >
        <div class="profile-editor-head">
          <el-input
            v-model="profile.name"
            placeholder="申请人选项名称"
            @change="dirty"
          /><el-tag v-if="profile.isDefault" type="success">默认</el-tag
          ><el-button v-else text type="primary" @click="setDefault(profile)"
            >设为默认</el-button
          ><el-button text type="danger" @click="removeProfile(profile)"
            >删除</el-button
          >
        </div>
        <div class="profile-grid">
          <el-input v-model="profile.applicant" placeholder="申请人" /><el-input
            v-model="profile.department"
            placeholder="所属部门"
          /><el-input
            v-model="profile.payeeName"
            placeholder="收款名称"
          /><el-input
            v-model="profile.account"
            placeholder="收款账号"
          /><el-input
            v-model="profile.bank"
            class="profile-wide"
            placeholder="开户行"
          />
        </div>
      </article>
    </div>
  </section>
</template>
