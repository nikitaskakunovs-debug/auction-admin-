import { OrderStatus } from "@/components/account/OrderStatus";

export const metadata = { title: "Pasūtījums", robots: { index: false } };

export default async function OrderStatusPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  return <OrderStatus orderRef={decodeURIComponent(ref)} />;
}
