import { Checkout } from "@/components/Checkout";

export const metadata = { title: "Apmaksa", robots: { index: false } };

export default async function CheckoutPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  return <Checkout orderRef={decodeURIComponent(ref)} />;
}
