import Link from 'next/link';

export const metadata = {
  title: '服务条款 | 课栈 KeStack',
  description: '课栈 KeStack 服务条款。',
};

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-background px-6 py-12 text-foreground">
      <article className="mx-auto max-w-3xl space-y-8">
        <header className="space-y-2">
          <Link href="/" className="text-sm text-primary hover:underline">
            课栈 KeStack
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight">服务条款</h1>
          <p className="text-sm text-muted-foreground">最后更新：2026 年 10 月 5 日</p>
        </header>
        <section className="space-y-3 text-sm leading-7">
          <h2 className="text-lg font-semibold">服务定位</h2>
          <p>
            课栈 KeStack 是用于辅助教学和自学的 AI
            工具。生成内容需要由用户自行核验，不构成医疗、法律、财务或其他专业建议，也不保证始终准确或完整。
          </p>
        </section>
        <section className="space-y-3 text-sm leading-7">
          <h2 className="text-lg font-semibold">用户责任</h2>
          <p>
            你应确保上传内容和生成用途合法，不上传无权处理的个人信息、机密资料或受限制内容，不利用服务侵害他人权益或规避服务限制。
          </p>
        </section>
        <section className="space-y-3 text-sm leading-7">
          <h2 className="text-lg font-semibold">服务变更</h2>
          <p>
            平台可能为了安全、性能或供应商变化调整功能。账号数据导出和删除入口属于数据控制能力，服务停止时会按照隐私政策处理数据。
          </p>
        </section>
      </article>
    </main>
  );
}
