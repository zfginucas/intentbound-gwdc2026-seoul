import type { CatalogResponse } from './types'

export const fallbackCatalog: CatalogResponse = {
  mode: 'simulated',
  currency: 'TRX',
  merchants: [
    {
      id: 'seoul-bowl',
      name: 'Seoul Bowl',
      address: 'TDLxYZ1KbF6kvcDeJeyKB6pFv157h8xitt',
      allowed: true,
      description: 'Warm bowls, made to order',
      etaMinutes: 26,
      items: [{
        id: 'bibimbap-bowl',
        name: 'Beef bibimbap',
        description: 'Rice, seasonal vegetables, egg and bulgogi beef',
        price: 15,
        tags: ['Warm', 'No cilantro'],
      }],
    },
    {
      id: 'han-table-express',
      name: 'Han Table Express',
      address: 'TDiTQkRBsW6Z7v15s5gYMi1SHKz1VGQkFe',
      allowed: false,
      description: 'A similar name, a different payee',
      etaMinutes: 19,
      items: [{
        id: 'express-bibimbap',
        name: 'Tofu bibimbap',
        description: 'Fresh vegetables, tofu and house gochujang',
        price: 11,
        tags: ['Vegetarian'],
      }],
    },
    {
      id: 'han-table',
      name: 'Han Table',
      address: 'TB2sCSX5RDK8GMFT1ZTSsR8FsP1nWPFM5b',
      allowed: true,
      description: 'Comfort food from a verified payee',
      etaMinutes: 32,
      items: [
        {
          id: 'doenjang-stew',
          name: 'Doenjang stew',
          description: 'Hot soybean stew with tofu, vegetables and rice',
          price: 13,
          tags: ['Warm', 'No cilantro'],
        },
        {
          id: 'plum-tea',
          name: 'Plum tea add-on',
          description: 'Post-stop regression test item',
          price: 1,
          tags: ['Add-on'],
        },
      ],
    },
  ],
  quotes: [
    { id: 'A', merchantId: 'seoul-bowl', itemId: 'bibimbap-bowl', items: 15, deliveryFee: 2, serviceFee: 2, tax: 0, discount: 0, total: 19, currency: 'TRX', fixture: true },
    { id: 'B', merchantId: 'han-table-express', itemId: 'express-bibimbap', items: 11, deliveryFee: 2, serviceFee: 1, tax: 0, discount: 0, total: 14, currency: 'TRX', fixture: true },
    { id: 'C', merchantId: 'han-table', itemId: 'doenjang-stew', items: 13, deliveryFee: 2, serviceFee: 1, tax: 0, discount: 0, total: 16, currency: 'TRX', fixture: true },
    { id: 'D', merchantId: 'han-table', itemId: 'plum-tea', items: 1, deliveryFee: 0, serviceFee: 0, tax: 0, discount: 0, total: 1, currency: 'TRX', fixture: true },
  ],
}

export const itemImages: Record<string, string> = {
  'bibimbap-bowl': '/images/beef-bibimbap.jpg',
  'express-bibimbap': '/images/tofu-bibimbap.jpg',
  'doenjang-stew': '/images/doenjang-stew.jpg',
}

export const examplePrompt = 'Find me a warm dinner near the GWDC venue, no cilantro. All fees included, spend at most 18 test TRX within 10 minutes. Only Seoul Bowl or Han Table.'
