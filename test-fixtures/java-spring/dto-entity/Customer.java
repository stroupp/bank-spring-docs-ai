package fixture.customer;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

@Getter
@Setter
@Entity
@Table(name = "customers")
public class Customer {
    @Id
    private Long id;

    @Column(name = "customer_name")
    private String name;

    @Enumerated(EnumType.STRING)
    private CustomerStatus status;

    @ManyToOne
    private CustomerGroup group;
}
