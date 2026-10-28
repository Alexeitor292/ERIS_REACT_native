# User guides

How to use ERIS, by role. Each guide shows what that role can do (a use-case
diagram), then step by step how to do it. The rules behind each step are in
[workflows](../architecture/workflows.md); the permissions in
[roles and permissions](../security/roles-and-permissions.md).

| You are | Read |
| --- | --- |
| Maintenance Crew (field reporter) | [Reporting incidents](reporting-incidents.md) |
| Maintenance Coordinator | [Triage and Incident Groups](triage-and-incident-groups.md) |
| Office Chief or Branch Chief | [Routing and review](routing-and-review.md) |
| Staff or Senior Specialist | [Technical forms](technical-forms.md) |
| Guest | [Reading the record](reading-the-record.md) |
| Administrator | [Administration](administration.md), [maintenance workflows](maintenance-workflows.md) |
| Everyone | [Signing in, My Work and notifications](everyday-use.md) |

## Who does what

```mermaid
flowchart LR
    crew(["Maintenance Crew"])
    coord(["Maintenance Coordinator"])
    oc(["Office Chief"])
    bc(["Branch Chief"])
    author(["Staff /<br/>Senior Specialist"])
    guest(["Guest"])
    admin(["Administrator"])

    subgraph field["In the field"]
        uc1["Report an incident"]
        uc2["Answer a request for information"]
    end
    subgraph triage["Triage"]
        uc3["Triage a report"]
        uc4["Start or join an Incident Group"]
        uc5["Close or reopen a group"]
    end
    subgraph assess["Assessment"]
        uc6["Route an assessment"]
        uc7["Assign a Staff member"]
        uc8["Fill and submit the technical form"]
        uc9["Approve or request revision"]
        uc10["Resolve the incident"]
        uc11["Share a form, add Consulted"]
    end
    subgraph read["Record"]
        uc12["Read approved records"]
        uc13["Follow My Work and notifications"]
    end
    subgraph adm["Administration"]
        uc14["Link people to Entra"]
        uc15["Place people in the organization"]
        uc16["Configure maintenance workflows"]
    end

    crew --> uc1
    crew --> uc2
    coord --> uc3
    coord --> uc4
    coord --> uc5
    oc --> uc6
    oc --> uc9
    oc --> uc11
    bc --> uc7
    bc --> uc9
    bc --> uc11
    author --> uc1
    author --> uc8
    author --> uc10
    author --> uc11
    guest --> uc12
    coord --> uc13
    oc --> uc13
    bc --> uc13
    author --> uc13
    admin --> uc14
    admin --> uc15
    admin --> uc16
```

## What each role sees in the menu

| Menu | Crew | Coordinator | Office / Branch Chief | Staff / Senior Specialist | Guest | Administrator |
| --- | --- | --- | --- | --- | --- | --- |
| Maintenance Work | if in a district maintenance workflow | if in a district maintenance workflow | if in a district maintenance workflow | if in a district maintenance workflow | — | ✓ |
| My Work | — | ✓ | ✓ | ✓ | — | ✓ |
| Mission Center, Incident Groups | — | ✓ | ✓ | ✓ | — | ✓ |
| Incidents | ✓ | ✓ | ✓ | ✓ | ✓ (approved only) | ✓ |
| Assessments | — | ✓ | ✓ | ✓ | ✓ (approved only) | ✓ |
| GIS Tools: Terrain Cross Sections | — | ✓ | ✓ | ✓ | — | ✓ |
| Organization | ✓ view | ✓ view; edits own district's crew | ✓ edits own office or branch | ✓ view | — | ✓ everything |
| Administration: Users, Road Inventory | — | — | — | — | — | ✓ |

Settings (theme, navigation, page transitions) and sign-out are in the profile
menu at the top right for everyone.

## A report's journey

```mermaid
journey
    title A slope failure, from the road to the approved record
    section Field
      Crew reports with photos: 4: Maintenance Crew
    section Triage
      Coordinator decides assessment required: 4: Maintenance Coordinator
      Coordinator starts an Incident Group: 3: Maintenance Coordinator
    section GeoTech
      Office Chief routes to a branch: 4: Office Chief
      Branch Chief assigns Staff: 4: Branch Chief
      Staff fills the GISA form: 3: Staff
      Branch Chief reviews and approves: 5: Branch Chief
    section Record
      Guests read the approved record: 5: Guest
```
