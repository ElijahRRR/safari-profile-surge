<script setup lang="ts">
// 根组件：未登录/会话过期显示说明页；已登录显示应用外壳。Toast 与全局弹窗挂在根上。
import { RouterView } from 'vue-router';
import { Spinner, ToastStack } from '@sfe/easyquick';
import AppLayout from './components/AppLayout.vue';
import RouteActionHost from './components/RouteActionHost.vue';
import LoginView from './views/LoginView.vue';
import { useConsole } from './store/context';

const { store, toasts, bootstrap } = useConsole();
</script>

<template>
  <div v-if="store.state.session.status === 'checking'" class="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-dark-950">
    <Spinner size="md" label="正在连接本机服务" />
  </div>
  <LoginView
    v-else-if="store.state.session.status !== 'authenticated'"
    :status="store.state.session.status"
    :message="store.state.session.message"
    @retry="bootstrap()"
  />
  <template v-else>
    <AppLayout>
      <RouterView />
    </AppLayout>
    <RouteActionHost />
  </template>
  <ToastStack :toasts="toasts.items" @dismiss="toasts.dismiss" />
</template>
