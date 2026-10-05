import Link from 'next/link';

export const metadata = {
  title: '隐私政策 | 课栈 KeStack',
  description: '课栈 KeStack 隐私政策与数据控制说明。',
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-background px-6 py-12 text-foreground">
      <article className="mx-auto max-w-3xl space-y-8">
        <header className="space-y-2">
          <Link href="/" className="text-sm text-primary hover:underline">
            课栈 KeStack
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight">隐私政策</h1>
          <p className="text-sm text-muted-foreground">最后更新：2026 年 10 月 5 日</p>
        </header>
        <section className="space-y-3 text-sm leading-7">
          <h2 className="text-lg font-semibold">我们保存什么</h2>
          <p>
            账号信息、你创建的课程和课堂内容、你主动上传的学习材料，以及为提供服务所需的运行记录。浏览器缓存、界面偏好和本地语音配置保存在你的设备上。
          </p>
        </section>
        <section className="space-y-3 text-sm leading-7">
          <h2 className="text-lg font-semibold">第三方处理</h2>
          <p>
            当你使用 AI
            生成、联网搜索、图片、视频、语音或文档解析功能时，相关输入可能发送给当前部署配置的第三方服务商。服务商、模型和密钥由平台运营方配置；平台不会在浏览器中暴露服务端密钥。
          </p>
        </section>
        <section className="space-y-3 text-sm leading-7">
          <h2 className="text-lg font-semibold">你的控制权</h2>
          <p>
            登录后可在设置中导出账号数据，或输入 DELETE
            永久删除账号及服务器上的课程、课堂、媒体、材料、运行记录和关联登录信息。账号删除后无法恢复。浏览器中的缓存和偏好可通过设置中的“清空本地缓存”单独删除。
          </p>
        </section>
        <section className="space-y-3 text-sm leading-7">
          <h2 className="text-lg font-semibold">保留期限与联系</h2>
          <p>
            服务运行所需的数据会在账号存续期间保留；删除请求完成后不再作为产品数据提供访问。数据库备份可能在其正常轮换周期内短暂保留。数据问题请通过部署方公布的支持渠道联系运营者。
          </p>
        </section>
      </article>
    </main>
  );
}
