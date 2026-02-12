export interface TicketNote {
  timestamp: string;
  text: string;
}

export interface ParsedTicket {
  id: string;
  status: string;
  assignee?: string;
  subject: string;
  description: string;
  notes: TicketNote[];
  tags: string[];
}

export function parseTicketShow(raw: string): ParsedTicket {
  const lines = raw.split('\n');
  
  // Find the YAML front matter boundaries
  const frontMatterStart = lines.findIndex(line => line.trim() === '---');
  const frontMatterEnd = lines.findIndex((line, index) => 
    index > frontMatterStart && line.trim() === '---'
  );
  
  if (frontMatterStart === -1 || frontMatterEnd === -1) {
    throw new Error('Invalid ticket format: missing YAML front matter');
  }
  
  // Parse front matter
  const frontMatterLines = lines.slice(frontMatterStart + 1, frontMatterEnd);
  const metadata = parseFrontMatter(frontMatterLines);
  
  // Parse content after front matter
  const contentLines = lines.slice(frontMatterEnd + 1);
  const { subject, description, notes } = parseContent(contentLines);
  
  return {
    id: metadata.id,
    status: metadata.status,
    assignee: metadata.assignee,
    subject,
    description,
    notes,
    tags: metadata.tags || []
  };
}

function parseFrontMatter(lines: string[]): any {
  const metadata: any = {};
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;
    
    const key = trimmed.substring(0, colonIndex).trim();
    const value = trimmed.substring(colonIndex + 1).trim();
    
    // Parse different value types
    if (key === 'tags' || key === 'deps' || key === 'links') {
      // Parse arrays like [team] or []
      if (value === '[]') {
        metadata[key] = [];
      } else if (value.startsWith('[') && value.endsWith(']')) {
        const content = value.slice(1, -1).trim();
        metadata[key] = content ? content.split(',').map(s => s.trim()) : [];
      }
    } else if (value === '') {
      // Skip empty values (like assignee might be missing)
      continue;
    } else {
      metadata[key] = value;
    }
  }
  
  return metadata;
}

function parseContent(lines: string[]): { subject: string; description: string; notes: TicketNote[] } {
  let subject = '';
  let description = '';
  const notes: TicketNote[] = [];
  
  let currentSection: 'subject' | 'description' | 'notes' = 'subject';
  let descriptionLines: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check for subject (first # heading)
    if (line.startsWith('# ') && !subject) {
      subject = line.substring(2).trim();
      currentSection = 'description';
      continue;
    }
    
    // Check for Notes section
    if (line.trim() === '## Notes') {
      currentSection = 'notes';
      // Save accumulated description
      description = descriptionLines.join('\n').trim();
      continue;
    }
    
    if (currentSection === 'description') {
      descriptionLines.push(line);
    } else if (currentSection === 'notes') {
      // Parse notes with timestamp and text
      if (line.startsWith('**') && line.includes('**')) {
        // Extract timestamp from **timestamp**
        const timestampMatch = line.match(/^\*\*(.*?)\*\*$/);
        if (timestampMatch) {
          const timestamp = timestampMatch[1];
          
          // Get the text that follows (next non-empty lines until next timestamp or end)
          let j = i + 1;
          const noteTextLines: string[] = [];
          
          while (j < lines.length && 
                 !lines[j].startsWith('**') && 
                 !lines[j].startsWith('## ')) {
            noteTextLines.push(lines[j]);
            j++;
          }
          
          const text = noteTextLines.join('\n').trim();
          if (text) {
            notes.push({ timestamp, text });
          }
          
          // Skip the lines we've processed
          i = j - 1;
        }
      }
    }
  }
  
  // If we never hit a Notes section, finalize description
  if (currentSection === 'description') {
    description = descriptionLines.join('\n').trim();
  }
  
  return { subject, description, notes };
}

export function getNewNotes(notes: TicketNote[], lastSeenCount: number): TicketNote[] {
  return notes.slice(lastSeenCount);
}
