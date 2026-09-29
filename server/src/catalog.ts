export const merchantIds = ["seoul-bowl", "han-table", "han-table-express"] as const;
export type MerchantId = (typeof merchantIds)[number];
export type QuoteId = "A" | "B" | "C" | "D";

export interface CatalogItem {
  id: string;
  name: string;
  description: string;
  price: number;
  priceSun: string;
  tags: string[];
  quoteId: QuoteId;
}

export interface CatalogMerchant {
  id: MerchantId;
  name: string;
  address: string;
  allowed: boolean;
  description: string;
  etaMinutes: number;
  items: CatalogItem[];
}

export interface CatalogQuote {
  id: QuoteId;
  merchantId: MerchantId;
  merchantAddress: string;
  itemId: string;
  items: number;
  deliveryFee: number;
  serviceFee: number;
  tax: number;
  discount: number;
  total: number;
  itemsSun: string;
  deliverySun: string;
  serviceSun: string;
  taxSun: string;
  discountSun: string;
  totalSun: string;
  currency: "TRX";
  fixture: true;
}

export interface Catalog {
  mode: "simulated";
  currency: "TRX";
  network: string;
  disclosure: string;
  merchants: CatalogMerchant[];
  quotes: CatalogQuote[];
}

const defaultAddresses: Record<MerchantId, string> = {
  "seoul-bowl": "TDLxYZ1KbF6kvcDeJeyKB6pFv157h8xitt",
  "han-table": "TB2sCSX5RDK8GMFT1ZTSsR8FsP1nWPFM5b",
  "han-table-express": "TDiTQkRBsW6Z7v15s5gYMi1SHKz1VGQkFe",
};

const addressEnvKeys: Record<MerchantId, string> = {
  "seoul-bowl": "MERCHANT_SEOUL_BOWL_ADDRESS",
  "han-table": "MERCHANT_HAN_TABLE_ADDRESS",
  "han-table-express": "MERCHANT_HAN_TABLE_EXPRESS_ADDRESS",
};

function merchantAddress(id: MerchantId, env: NodeJS.ProcessEnv): string {
  const address = env[addressEnvKeys[id]]?.trim() || defaultAddresses[id];
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) {
    throw new Error(`Invalid public Tron address in ${addressEnvKeys[id]}`);
  }
  return address;
}

function sun(trx: number): string {
  return String(trx * 1_000_000);
}

export function getCatalog(env: NodeJS.ProcessEnv = process.env): Catalog {
  const merchants: CatalogMerchant[] = [
    {
      id: "seoul-bowl",
      name: "Seoul Bowl",
      address: merchantAddress("seoul-bowl", env),
      allowed: true,
      description: "Build-your-own Korean rice bowls near the venue.",
      etaMinutes: 24,
      items: [
        {
          id: "bibimbap-bowl",
          name: "Warm Bibimbap Bowl",
          description: "Beef, seasonal vegetables and rice; prepared without cilantro.",
          price: 15,
          priceSun: sun(15),
          tags: ["warm", "no cilantro", "rice"],
          quoteId: "A",
        },
      ],
    },
    {
      id: "han-table",
      name: "Han Table",
      address: merchantAddress("han-table", env),
      allowed: true,
      description: "Home-style Korean meals and small sides.",
      etaMinutes: 28,
      items: [
        {
          id: "doenjang-stew",
          name: "Doenjang Stew Set",
          description: "Hot soybean stew, rice and banchan; no cilantro.",
          price: 13,
          priceSun: sun(13),
          tags: ["warm", "no cilantro", "comfort food"],
          quoteId: "C",
        },
        {
          id: "plum-tea",
          name: "Plum Tea Add-on",
          description: "A one-TRX add-on used to test revocation after the meal payment.",
          price: 1,
          priceSun: sun(1),
          tags: ["add-on", "revocation test"],
          quoteId: "D",
        },
      ],
    },
    {
      id: "han-table-express",
      name: "Han Table Express",
      address: merchantAddress("han-table-express", env),
      allowed: false,
      description: "A similarly named but separate simulated merchant.",
      etaMinutes: 18,
      items: [
        {
          id: "express-bibimbap",
          name: "Express Bibimbap",
          description: "Fast rice bowl; this merchant is outside the demo allowlist.",
          price: 11,
          priceSun: sun(11),
          tags: ["warm", "rice", "not allowlisted"],
          quoteId: "B",
        },
      ],
    },
  ];

  const templates = [
    { id: "A", merchantId: "seoul-bowl", itemId: "bibimbap-bowl", items: 15, deliveryFee: 2, serviceFee: 2 },
    { id: "B", merchantId: "han-table-express", itemId: "express-bibimbap", items: 11, deliveryFee: 2, serviceFee: 1 },
    { id: "C", merchantId: "han-table", itemId: "doenjang-stew", items: 13, deliveryFee: 2, serviceFee: 1 },
    { id: "D", merchantId: "han-table", itemId: "plum-tea", items: 1, deliveryFee: 0, serviceFee: 0 },
  ] as const;

  const quotes: CatalogQuote[] = templates.map((template) => {
    const tax = 0;
    const discount = 0;
    const total = template.items + template.deliveryFee + template.serviceFee + tax - discount;
    return {
      ...template,
      merchantAddress: merchants.find((merchant) => merchant.id === template.merchantId)!.address,
      tax,
      discount,
      total,
      itemsSun: sun(template.items),
      deliverySun: sun(template.deliveryFee),
      serviceSun: sun(template.serviceFee),
      taxSun: sun(tax),
      discountSun: sun(discount),
      totalSun: sun(total),
      currency: "TRX",
      fixture: true,
    };
  });

  return {
    mode: "simulated",
    currency: "TRX",
    network: env.TRON_NETWORK?.trim() || "shasta",
    disclosure: "Restaurants, menus, quotes and fulfillment are simulated. Testnet payments are separate evidence.",
    merchants,
    quotes,
  };
}
