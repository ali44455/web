import { Route, Switch, Router as WouterRouter } from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';

import Layout from '@/components/layout';
import Home from '@/pages/home';
import Guide from '@/pages/guide';
import About from '@/pages/about';
import Reports from '@/pages/reports';
import Stage1 from '@/pages/simulator/stage1';
import Stage0 from '@/pages/simulator/stage0';
import Stage2 from '@/pages/simulator/stage2';
import Stage3 from '@/pages/simulator/stage3';
import Stage4 from '@/pages/simulator/stage4';
import Stage5 from '@/pages/simulator/stage5';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/guide" component={Guide} />
        <Route path="/about" component={About} />
        <Route path="/reports" component={Reports} />
        <Route path="/simulator" component={Stage1} />
        <Route path="/simulator/stage-0" component={Stage0} />
        <Route path="/simulator/stage-1" component={Stage1} />
        <Route path="/simulator/stage-2" component={Stage2} />
        <Route path="/simulator/stage-3" component={Stage3} />
        <Route path="/simulator/stage-4" component={Stage4} />
        <Route path="/simulator/stage-5" component={Stage5} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
