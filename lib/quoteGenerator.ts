/**
 * Quote generation utilities for painting/contractor jobs.
 */

export interface QuoteOption {
  tier: 'basic' | 'standard' | 'premium';
  price: number;
  description: string;
  timeline: string;
  advance_percentage: number;
  includes?: string[];
}

export interface QuoteRequest {
  leadId: string;
  jobType?: string;
  location?: string;
  requirements?: {
    options?: number; // e.g., 3 for basic/standard/premium
    timeline?: string;
    advance?: number; // percentage
    labour_and_material?: boolean;
  };
}

export interface QuoteResponse {
  success: boolean;
  options?: QuoteOption[];
  error?: string;
}

/**
 * Generate quote options for a lead.
 * This is a sample/stub implementation that generates mock quotes.
 * In production, this would call your actual quote generation service/API.
 */
export async function generateQuoteOptions(
  request: QuoteRequest
): Promise<QuoteResponse> {
  try {
    // TODO: Replace this with actual quote generation logic
    // For now, generate sample quotes based on requirements
    
    const numOptions = request.requirements?.options || 3;
    const timeline = request.requirements?.timeline || '5 days';
    const advance = request.requirements?.advance || 30;
    
    const options: QuoteOption[] = [];
    
    if (numOptions >= 1) {
      options.push({
        tier: 'basic',
        price: 50000,
        description: 'Basic painting with standard quality paint, single coat',
        timeline,
        advance_percentage: advance,
        includes: ['Labour', 'Material (standard paint)', 'Basic preparation'],
      });
    }
    
    if (numOptions >= 2) {
      options.push({
        tier: 'standard',
        price: 75000,
        description: 'Standard painting with premium quality paint, double coat',
        timeline,
        advance_percentage: advance,
        includes: ['Labour', 'Material (premium paint)', 'Full preparation', 'Primer'],
      });
    }
    
    if (numOptions >= 3) {
      options.push({
        tier: 'premium',
        price: 100000,
        description: 'Premium painting with luxury paint, double coat, putty work',
        timeline,
        advance_percentage: advance,
        includes: [
          'Labour',
          'Material (luxury paint)',
          'Full preparation',
          'Putty work',
          'Primer',
          'Damp proofing',
        ],
      });
    }
    
    return {
      success: true,
      options,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to generate quotes',
    };
  }
}

/**
 * Format quote options into a user-friendly message (Hinglish).
 */
export function formatQuoteOptions(options: QuoteOption[]): string {
  if (options.length === 0) {
    return 'Kuch quotes generate nahi ho paye. Kripya thoda detail aur share karein.';
  }
  
  const parts: string[] = [];
  parts.push('Main aapke liye quote options ready kar diya hai:\n');
  
  options.forEach((option, index) => {
    const tierName = option.tier.charAt(0).toUpperCase() + option.tier.slice(1);
    parts.push(`${index + 1}. **${tierName} Option**`);
    parts.push(`   Price: ₹${option.price.toLocaleString('en-IN')}`);
    parts.push(`   Description: ${option.description}`);
    parts.push(`   Timeline: ${option.timeline}`);
    parts.push(`   Advance: ${option.advance_percentage}%`);
    
    if (option.includes && option.includes.length > 0) {
      parts.push(`   Includes: ${option.includes.join(', ')}`);
    }
    
    parts.push(''); // Empty line between options
  });
  
  parts.push('Aap kaunse option ko prefer karenge? Ya agar koi modification chahiye to batao.');
  
  return parts.join('\n');
}

