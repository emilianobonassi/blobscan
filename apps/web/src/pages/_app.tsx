import "../styles/globals.css";
import type { AppProps as NextAppProps } from "next/app";

import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/public-sans/400.css";
import "@fontsource/public-sans/500.css";
import Head from "next/head";

import { api } from "~/api";
import AppLayout from "~/components/AppLayout/AppLayout";

function MyApp({ Component, pageProps }: NextAppProps) {
  return (
    <>
      <Head>
        <title>Blobscan</title>
        <meta name="description" content="Generated by create next app" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <AppLayout>
        <Component {...pageProps} />
      </AppLayout>
    </>
  );
}

export default api.withTRPC(MyApp);
